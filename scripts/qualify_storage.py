"""Measure a first full import and randomized mixed reads during collection.

Reads a frozen SQLite backup; all output/data stays in a NEW scratch directory.
Never writes to the source or to an installed Runtrace directory.
"""
import argparse
import concurrent.futures
from contextlib import closing
import ctypes
from ctypes import wintypes
import json
import hashlib
import os
from pathlib import Path
import random
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from storage_qualification import validate_full_import

p = argparse.ArgumentParser()
p.add_argument('--exe', required=True)
p.add_argument('--source', required=True)
p.add_argument('--seed', type=int, default=20261117)
p.add_argument('--memory-limit-mb', type=int, default=2048)
p.add_argument('--import-only', action='store_true')
p.add_argument('--abort-over-mb', type=float, help='Stop this owned scratch import once peak working set exceeds this decimal MB ceiling')
p.add_argument('--import-threads', type=int, default=4)
p.add_argument('--serve-memory-limit-mb', type=int, default=2048)
p.add_argument('--frozen-source', action='store_true', help='Input is an immutable offline snapshot; link/copy it instead of taking another SQLite backup')
p.add_argument('--use-import-defaults', action='store_true', help='Qualify the CLI defaults instead of overriding its import budget/workers')
a = p.parse_args()
assert os.name == 'nt', 'This measurement uses the Windows peak working-set counter'
root = Path(tempfile.mkdtemp(prefix='runtrace-storage-'))
original_exe = Path(a.exe).resolve()
exe_sha256 = hashlib.sha256(original_exe.read_bytes()).hexdigest()
assert a.abort_over_mb is None or a.abort_over_mb > 0
# Windows locks running executables. Measure a copy so a long import does not
# prevent the source checkout from building the next candidate.
(root/'bin').mkdir()
copied_exe = root/'bin'/original_exe.name
shutil.copy2(original_exe, copied_exe)
if (original_exe.parent/'duckdb.dll').is_file():
    shutil.copy2(original_exe.parent/'duckdb.dll', root/'bin/duckdb.dll')
exe = str(copied_exe)
env = {k: v for k, v in os.environ.items() if not k.startswith(('RUNTRACE_', 'T3UI_'))}
print(json.dumps({'scratch': str(root)}), flush=True)
source = root/'source.sqlite'
try:
    if a.frozen_source:
        original_source = Path(a.source).resolve()
        wal = Path(str(original_source)+'-wal')
        assert not wal.exists() or wal.stat().st_size == 0, 'Frozen input must have no pending WAL'
        try:
            os.link(original_source, source)
        except OSError:
            shutil.copy2(original_source, source)
    else:
        with closing(sqlite3.connect(Path(a.source).resolve().as_uri()+'?mode=ro', uri=True)) as src:
            # Pin one WAL snapshot so active source writes cannot restart the backup.
            src.execute('BEGIN')
            src.execute('SELECT count(*) FROM sqlite_master').fetchone()
            with closing(sqlite3.connect(source)) as dst:
                src.backup(dst)
            src.rollback()
    with closing(sqlite3.connect(source.resolve().as_uri()+'?mode=ro', uri=True)) as frozen:
        expected_projects = frozen.execute('SELECT count(*) FROM projection_projects WHERE deleted_at IS NULL').fetchone()[0]
        expected_threads = frozen.execute("SELECT count(*) FROM orchestration_v2_projection_threads WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.projectId') END IN (SELECT project_id FROM projection_projects WHERE deleted_at IS NULL)").fetchone()[0]
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    config = Path('config/default.toml').read_text()
    config = config.replace('port = 4310', f'port = {port}')
    config = config.replace('./data/t3-usage.duckdb', (root/'data/fixture.duckdb').as_posix())
    config = config.replace('./data/archive', (root/'archive').as_posix())
    config = config.replace('sqlite_path = ""', f'sqlite_path = "{source.as_posix()}"')
    config = config.replace('poll_seconds = 60', 'poll_seconds = 5')
    config = config.replace('checks = true', 'checks = false')
    config = config.replace('notifications = true', 'notifications = false')
    config = config.replace('memory_limit_mb = 2048', f'memory_limit_mb = {a.memory_limit_mb}')
    config += '\n[update]\ncheck = false\n'
    settings = root/'config.toml'
    settings.write_text(config)

    class Memory(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
            (n, ctypes.c_size_t) for n in ['PeakWorkingSetSize', 'WorkingSetSize',
            'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
            'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage']]

    get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
    get_memory.argtypes = [wintypes.HANDLE, ctypes.POINTER(Memory), wintypes.DWORD]
    get_memory.restype = wintypes.BOOL
    began = time.monotonic()
    peak = 0
    peak_private_commit = 0
    aborted_memory_ceiling = False
    final_counter_available = False
    import_args = [exe, 'import', '--all', '--config', str(settings)]
    help_text = subprocess.check_output([exe, 'import', '--help'], env=env, text=True)
    if '--memory-limit-mb' in help_text and not a.use_import_defaults:
        import_args += ['--memory-limit-mb', str(a.memory_limit_mb), '--threads', str(a.import_threads)]
    with (root/'import.json').open('w') as out, (root/'import.log').open('w') as err:
        proc = subprocess.Popen(import_args,
                                env=env, stdout=out, stderr=err)
        try:
            while proc.poll() is None:
                m = Memory()
                m.cb = ctypes.sizeof(m)
                if not get_memory(int(proc._handle), ctypes.byref(m), m.cb):
                    proc.kill()
                    raise ctypes.WinError()
                peak = max(peak, m.PeakWorkingSetSize)
                peak_private_commit = max(peak_private_commit, m.PeakPagefileUsage)
                if a.abort_over_mb is not None and peak > a.abort_over_mb*1_000_000:
                    aborted_memory_ceiling = True
                    proc.kill()
                    proc.wait(timeout=30)
                    break
                time.sleep(.02)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=30)
        final_memory = Memory()
        final_memory.cb = ctypes.sizeof(final_memory)
        final_counter_available = bool(get_memory(int(proc._handle), ctypes.byref(final_memory), final_memory.cb))
        if final_counter_available:
            peak = max(peak, final_memory.PeakWorkingSetSize)
            peak_private_commit = max(peak_private_commit, final_memory.PeakPagefileUsage)
        if proc.returncode != 0:
            failed = {'import_exit_code': proc.returncode,
                      'first_import_seconds': round(time.monotonic()-began, 3),
                      'peak_working_set_bytes': peak, 'peak_private_commit_bytes': peak_private_commit,
                      'peak_mb_decimal': round(peak/1_000_000, 3),
                      'memory_limit_mb': None if a.use_import_defaults else a.memory_limit_mb,
                      'import_threads': None if a.use_import_defaults else a.import_threads,
                      'configured_memory_limit_mb': a.memory_limit_mb, 'use_import_defaults': a.use_import_defaults, 'complete': False, 'aborted_memory_ceiling': aborted_memory_ceiling,
                      'counter_after_exit_available': final_counter_available, 'exe_sha256': exe_sha256}
            (root/'result.json').write_text(json.dumps(failed, indent=2))
            print(json.dumps(failed), flush=True)
            raise AssertionError(f'Import failed; inspect {root}/import.log')
    report = json.loads((root/'import.json').read_text())
    if a.use_import_defaults:
        assert 'import_memory_limit_mb' in report, 'This binary does not report its effective import defaults'
    result = {'first_import_seconds': round(time.monotonic()-began, 3),
              'peak_working_set_bytes': peak, 'peak_private_commit_bytes': peak_private_commit, 'peak_mb_decimal': round(peak/1_000_000, 3),
              'within_400_mb': peak <= 400_000_000, 'seed': a.seed,
              'memory_limit_mb': report.get('import_memory_limit_mb', a.memory_limit_mb),
              'partial_import': report.get('partial_sync') is not False,
              'expected_source_projects': expected_projects, 'expected_source_threads': expected_threads,
              'import_complete': False, 'qualified': False,
              'import_threads': report.get('import_threads', a.import_threads),
              'projects_synced': report.get('projects_synced'),
              'projects_discovered': report.get('projects_discovered'),
              'changed_records': report.get('changed'), 'exe_sha256': exe_sha256,
              'counter_after_exit_available': final_counter_available}
    try:
        validate_full_import(report, expected_projects, expected_threads, peak)
    except ValueError as error:
        result['qualification_error'] = str(error)
        (root/'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
        raise
    result['import_complete'] = True
    result['qualified'] = a.import_only
    (root/'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    if a.import_only:
        sys.exit(0)
    # A low offline backfill budget is independent of the serving/query budget.
    settings.write_text(config.replace(f'memory_limit_mb = {a.memory_limit_mb}',
                                      f'memory_limit_mb = {a.serve_memory_limit_mb}'))
    result['serve_memory_limit_mb'] = a.serve_memory_limit_mb
    base = f'http://127.0.0.1:{port}'
    # Ignore OS proxy configuration for loopback measurements.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def read(route):
        start = time.monotonic()
        try:
            with opener.open(base+route, timeout=120) as response:
                data = json.load(response)
                return response.status, (time.monotonic()-start)*1000, data
        except urllib.error.HTTPError as error:
            return error.code, (time.monotonic()-start)*1000, json.load(error)
        except OSError:
            return 0, (time.monotonic()-start)*1000, None

    with (root/'serve.log').open('w') as log:
        service = subprocess.Popen([exe, 'serve', '--config', str(settings)], env=env,
                                   stdout=log, stderr=log)
        try:
            # First-time cold maintenance may outlast HTTP process readiness.
            deadline = time.monotonic()+1800
            while True:
                assert service.poll() is None, 'Service exited'
                try:
                    _, _, h = read('/health/ready')
                    if h is not None:
                        assert h['pid'] == service.pid, 'Unexpected port owner'
                        if h['collector'].get('state') == 'synced':
                            break
                except OSError:
                    pass
                assert time.monotonic() < deadline, 'Collector never synced'
                time.sleep(.1)
            before = h['collector']
            routes = ['/api/v1/'+r for r in [
                'overview', 'threads?limit=50', 'tool-calls?limit=500',
                'tool-calls?limit=500&offset=1500', 'tool-calls?limit=500&include_content=true',
                'model-turns?limit=500&shape=lean', 'models', 'usage/projects',
                'usage/tools', 'data-quality/fields', 'quota/windows', 'quota/live']]
            rng = random.Random(a.seed)
            workload = [rng.choice(routes) for _ in range(500)]
            start = time.monotonic()
            def request_result(route):
                code, elapsed, _ = read(route)
                # Validate JSON, then release bodies rather than retaining 500
                # full-content pages in the measurement driver.
                return code, elapsed
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                responses = list(pool.map(request_result, workload))
            _, _, after = read('/health/ready')
            codes = {}
            route_codes = {}
            for route, (code, _) in zip(workload, responses):
                codes[str(code)] = codes.get(str(code), 0)+1
                counts = route_codes.setdefault(route, {})
                counts[str(code)] = counts.get(str(code), 0)+1
            latency = sorted(r[1] for r in responses)
            result.update({'requests': len(responses), 'workers': 4, 'statuses': codes,
                           'route_statuses': route_codes,
                           'request_seconds': round(time.monotonic()-start, 3),
                           'median_ms': round(latency[250], 3), 'p95_ms': round(latency[474], 3),
                           'collector_before': before, 'collector_after': after['collector']})
            result['all_200'] = codes == {'200': 500}
            result['collector_advanced'] = (
                after['collector'].get('last_successful_sync_at') != before.get('last_successful_sync_at')
                and after['collector'].get('state') == 'synced')
            (root/'result.json').write_text(json.dumps(result, indent=2))
            print(json.dumps(result), flush=True)
            assert result['all_200'], 'Mixed request pass had errors'
            assert result['collector_advanced'], 'Collector did not advance successfully during requests'
            result['qualified'] = True
            (root/'result.json').write_text(json.dumps(result, indent=2))
            print(json.dumps(result), flush=True)
        finally:
            service.terminate()
            service.wait(timeout=30)
finally:
    # SQLite WAL sidecars are raw source data too.
    for suffix in ('', '-wal', '-shm', '-journal'):
        Path(str(source)+suffix).unlink(missing_ok=True)
