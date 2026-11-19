"""Isolate native index growth with neutral metadata, not a full-import claim.

Each variant owns a new temporary database and a fresh Python/DuckDB process.
The three variants distinguish explicit secondary indexes from the redundant
identity UNIQUE index. Schema and transactions model the importer's key tables;
payload distribution and Rust allocation are deliberately not simulated.
"""
import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

p = argparse.ArgumentParser()
p.add_argument('--dll', required=True)
p.add_argument('--variant', choices=['all', 'baseline', 'no-secondary', 'no-identity-unique'], default='all')
p.add_argument('--rows', type=int, default=300_000)
p.add_argument('--memory-mb', type=int, default=96)
p.add_argument('--checkpoint-rows', type=int, default=10_000)
p.add_argument('--batch-rows', type=int, default=1_000)
p.add_argument('--reopen-checkpoints', action='store_true')
a = p.parse_args()
assert 1_000 <= a.rows <= 1_000_000
assert 64 <= a.memory_mb <= 512
assert 1 <= a.batch_rows <= a.checkpoint_rows and a.checkpoint_rows % a.batch_rows == 0
if a.variant == 'all':
    for variant in ['baseline', 'no-secondary', 'no-identity-unique']:
        subprocess.run([sys.executable, '-u', __file__, '--dll', a.dll, '--variant', variant,
                        '--rows', str(a.rows), '--memory-mb', str(a.memory_mb),
                        '--checkpoint-rows', str(a.checkpoint_rows), '--batch-rows', str(a.batch_rows),
                        *(['--reopen-checkpoints'] if a.reopen_checkpoints else [])], check=True)
    sys.exit(0)

root = Path(tempfile.mkdtemp(prefix='runtrace-index-probe-'))
dll = ctypes.CDLL(str(Path(a.dll).resolve()))

class Result(ctypes.Structure):
    _fields_ = [('columns', ctypes.c_uint64), ('rows', ctypes.c_uint64), ('changed', ctypes.c_uint64),
                ('column_data', ctypes.c_void_p), ('error', ctypes.c_void_p), ('internal', ctypes.c_void_p)]

for name, args in {
    'duckdb_open': [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)],
    'duckdb_connect': [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
    'duckdb_query': [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(Result)],
    'duckdb_result_error': [ctypes.POINTER(Result)],
    'duckdb_value_varchar': [ctypes.POINTER(Result), ctypes.c_uint64, ctypes.c_uint64],
    'duckdb_free': [ctypes.c_void_p],
    'duckdb_destroy_result': [ctypes.POINTER(Result)],
    'duckdb_disconnect': [ctypes.POINTER(ctypes.c_void_p)],
    'duckdb_close': [ctypes.POINTER(ctypes.c_void_p)],
}.items():
    getattr(dll, name).argtypes = args
dll.duckdb_result_error.restype = ctypes.c_char_p
dll.duckdb_value_varchar.restype = ctypes.c_void_p
db, conn = ctypes.c_void_p(), ctypes.c_void_p()
assert dll.duckdb_open(str(root/'probe.duckdb').encode(), ctypes.byref(db)) == 0
assert dll.duckdb_connect(db, ctypes.byref(conn)) == 0

def sql(query, value=False):
    result = Result()
    try:
        if dll.duckdb_query(conn, query.encode(), ctypes.byref(result)):
            raise RuntimeError(dll.duckdb_result_error(ctypes.byref(result)).decode())
        if value:
            ptr = dll.duckdb_value_varchar(ctypes.byref(result), 0, 0)
            try:
                return ctypes.string_at(ptr).decode()
            finally:
                dll.duckdb_free(ptr)
    finally:
        dll.duckdb_destroy_result(ctypes.byref(result))

class Memory(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in ['PeakWorkingSetSize', 'WorkingSetSize',
        'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
        'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage']]

ctypes.windll.kernel32.GetCurrentProcess.restype = wintypes.HANDLE
get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
get_memory.argtypes = [wintypes.HANDLE, ctypes.POINTER(Memory), wintypes.DWORD]

def peak():
    m = Memory()
    m.cb = ctypes.sizeof(m)
    assert get_memory(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(m), m.cb)
    return m.PeakWorkingSetSize

report = {'variant': a.variant, 'requested_rows': a.rows, 'memory_mb': a.memory_mb,
          'checkpoint_rows': a.checkpoint_rows, 'batch_rows': a.batch_rows,
          'reopen_checkpoints': a.reopen_checkpoints,
          'committed_rows': 0, 'complete': False, 'scratch': str(root)}
started = time.monotonic()
try:
    sql(f"SET memory_limit='{a.memory_mb}MB'; SET threads=1")
    schema = Path('migrations/001_initial.sql').read_text()
    if a.variant == 'no-identity-unique':
        schema = schema.replace(',\n UNIQUE(instance_id,kind,source_id)', '')
    sql(schema)
    sql(Path('migrations/002_revision_cache.sql').read_text())
    if a.variant != 'baseline':
        sql('DROP INDEX records_kind_time; DROP INDEX records_thread')
    for start in range(0, a.rows, a.batch_rows):
        end = min(start+a.batch_rows, a.rows)
        sql(f"""BEGIN;
INSERT INTO records SELECT sha256('record:'||i),'tool','machine',
 'provider-item:'||sha256('source:'||i),'project','thread:'||(i%2500),'run:'||(i//12),
 '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','partial','fixture','v1',
 '2026-11-17T00:00:00Z',sha256('payload:'||i),json_object('body',repeat('x',1024)) FROM range({start},{end}) t(i);
INSERT INTO events SELECT sha256('event:'||i),sha256('record:'||i),'captured',
 '2026-01-01T00:00:00Z','2026-11-17T00:00:00Z',sha256('payload:'||i),'machine','project',
 'thread:'||(i%2500),'partial','fixture','v1','2026-01-01T00:00:00Z' FROM range({start},{end}) t(i);
INSERT INTO source_revisions SELECT 'machine','tool','provider-item:'||sha256('source:'||i),
 sha256('revision:'||i) FROM range({start},{end}) t(i);
COMMIT;""")
        report['committed_rows'] = end
        if end % a.checkpoint_rows == 0 or end == a.rows:
            report['memory_before_checkpoint'] = json.loads(sql("SELECT to_json(list(struct_pack(tag:=tag,bytes:=memory_usage_bytes))) FROM duckdb_memory() WHERE memory_usage_bytes>0", True))
            sql('CHECKPOINT')
            report['native_memory'] = json.loads(sql("SELECT to_json(list(struct_pack(tag:=tag,bytes:=memory_usage_bytes))) FROM duckdb_memory() WHERE memory_usage_bytes>0", True))
            if a.reopen_checkpoints:
                dll.duckdb_disconnect(ctypes.byref(conn))
                dll.duckdb_close(ctypes.byref(db))
                assert dll.duckdb_open(str(root/'probe.duckdb').encode(), ctypes.byref(db)) == 0
                assert dll.duckdb_connect(db, ctypes.byref(conn)) == 0
                sql(f"SET memory_limit='{a.memory_mb}MB'; SET threads=1")
    report['complete'] = True
except RuntimeError as error:
    report['error'] = str(error)
finally:
    report['seconds'] = round(time.monotonic()-started, 3)
    report['peak_working_set_bytes'] = peak()
    (root/'result.json').write_text(json.dumps(report, indent=2))
    dll.duckdb_disconnect(ctypes.byref(conn))
    dll.duckdb_close(ctypes.byref(db))
print(json.dumps(report), flush=True)
