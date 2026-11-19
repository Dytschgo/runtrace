"""Crash/intentional-stop qualification using only a fresh database and port.

Usage: python scripts/verify_supervisor.py --exe target/debug/runtrace.exe
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

p = argparse.ArgumentParser()
p.add_argument('--exe', required=True)
a = p.parse_args()
exe = str(Path(a.exe).resolve())
env = {k: v for k, v in os.environ.items() if not k.startswith(('RUNTRACE_', 'T3UI_'))}
with tempfile.TemporaryDirectory(prefix='runtrace-supervisor-') as tmp:
    root = Path(tmp)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    config = Path('config/default.toml').read_text()
    config = config.replace('port = 4310', f'port = {port}')
    config = config.replace('./data/t3-usage.duckdb', (root/'data/fixture.duckdb').as_posix())
    config = config.replace('./data/archive', (root/'archive').as_posix())
    config = config.replace('sqlite_path = ""', f'sqlite_path = "{root.as_posix()}/absent.sqlite"')
    config = config.replace('collect_on_serve = true', 'collect_on_serve = false')
    config += '\n[update]\ncheck = false\n'
    (root/'data').mkdir()
    settings = root/'config.toml'
    settings.write_text(config)

    def command(*args):
        # Detached Windows grandchildren may retain pipe handles; file-backed logs
        # keep command completion tied to the command process, not inherited pipes.
        with (root/'command.log').open('w') as log:
            return subprocess.run([exe, *args, '--config', str(settings)], env=env,
                                  check=True, stdout=log, stderr=log, text=True, timeout=90)

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def health():
        try:
            with opener.open(f'http://127.0.0.1:{port}/health/ready', timeout=2) as r:
                return json.load(r)
        except OSError:
            return None

    def request_status(route, host, origin=None, forwarded=None):
        headers = {'Host': host}
        if origin:
            headers['Origin'] = origin
        if forwarded:
            headers['X-Forwarded-Host'] = forwarded
        request = urllib.request.Request(f'http://127.0.0.1:{port}'+route, headers=headers)
        try:
            with opener.open(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    try:
        command('start')
        routes = ['/', '/health/ready', '/api/v1/overview', '/api/v1/update']
        remote = 'dashboard.example.test:12443'
        for route in routes:
            assert request_status(route, remote) == 403, (route, 'default must reject remote Host')
        command('stop')
        settings.write_text(config.replace('allowed_hosts = []', f'allowed_hosts = ["{remote}"]'))
        command('start')
        for route in routes:
            assert request_status(route, remote, 'https://'+remote) == 200, (route, 'explicit Host must work')
            assert request_status(route, 'attacker.test:12443', forwarded=remote) == 403
            assert request_status(route, remote, 'https://attacker.test') == 403
        first = health()
        assert first and first['ready']
        command('start')  # idempotent; no second owner
        assert health()['pid'] == first['pid']
        began = time.monotonic()
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(first['pid']), '/F'], check=True, capture_output=True)
        else:
            import signal
            os.kill(first['pid'], signal.SIGKILL)
        recovered = None
        while time.monotonic() - began < 30:
            h = health()
            if h and h['pid'] != first['pid']:
                recovered = h
                break
            time.sleep(.1)
        assert recovered and recovered['storage_identity'] == first['storage_identity']
        recovery = round(time.monotonic() - began, 3)
        command('stop')
        time.sleep(3)  # exceeds the restart delay: intentional stop must stay stopped
        assert health() is None
        assert not (root/'runtrace.running').exists()
        command('start')
        assert health()['ready']
        command('stop')
        # Stop during the two-second crash backoff, when there is no health responder.
        command('start')
        victim = health()['pid']
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(victim), '/F'], check=True, capture_output=True)
        else:
            os.kill(victim, signal.SIGKILL)
        command('stop')
        assert 'Runtrace stopped.' in (root/'command.log').read_text()
        time.sleep(3)
        assert health() is None
        command('stop')
        print(json.dumps({'crash_recovery_seconds': recovery, 'same_database': True,
                          'idempotent_start': True, 'intentional_stop_stays_stopped': True,
                          'restart_after_stop': True, 'stop_during_crash_backoff': True,
                          'host_admission_checks': 16}))
    finally:
        command('stop')
