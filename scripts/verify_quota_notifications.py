"""Qualify two native warnings and restart deduplication on neutral quota data.

--native actually displays Windows notifications. No installed database is opened.
"""
import argparse
import ctypes
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile

p = argparse.ArgumentParser()
p.add_argument('--exe', required=True)
p.add_argument('--native', action='store_true')
a = p.parse_args()
exe = Path(a.exe).resolve()
env = {k: v for k, v in os.environ.items() if not k.startswith(('RUNTRACE_', 'T3UI_'))}
dll = ctypes.CDLL(str(exe.parent/'duckdb.dll'))
class Result(ctypes.Structure):
    _fields_ = [('columns', ctypes.c_uint64), ('rows', ctypes.c_uint64), ('changed', ctypes.c_uint64), ('column_data', ctypes.c_void_p), ('error', ctypes.c_void_p), ('internal', ctypes.c_void_p)]
dll.duckdb_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
dll.duckdb_connect.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
dll.duckdb_query.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(Result)]
dll.duckdb_result_error.argtypes = [ctypes.POINTER(Result)]
dll.duckdb_result_error.restype = ctypes.c_char_p
dll.duckdb_destroy_result.argtypes = [ctypes.POINTER(Result)]
dll.duckdb_disconnect.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
dll.duckdb_close.argtypes = [ctypes.POINTER(ctypes.c_void_p)]

with tempfile.TemporaryDirectory(prefix='runtrace-notify-') as directory:
    root = Path(directory)
    config = Path('config/default.toml').read_text().replace('./data/t3-usage.duckdb', (root/'fixture.duckdb').as_posix()).replace('./data/archive', (root/'archive').as_posix())
    config = config.replace('sqlite_path = ""', f'sqlite_path = "{(root/"no-source.sqlite").as_posix()}"').replace('collect_on_serve = true', 'collect_on_serve = false').replace('checks = true', 'checks = false')
    settings = root/'config.toml'
    settings.write_text(config)
    def command(name):
        out = subprocess.check_output([str(exe), *name, '--config', str(settings)], env=env, text=True)
        return json.loads(out)
    command(['storage', 'stats'])
    now = datetime.now(timezone.utc).replace(microsecond=0)
    reset = (now + timedelta(hours=3)).isoformat()
    def seed(used, second=0):
        db = ctypes.c_void_p()
        conn = ctypes.c_void_p()
        assert dll.duckdb_open(str(root/'fixture.duckdb').encode(), ctypes.byref(db)) == 0
        try:
            assert dll.duckdb_connect(db, ctypes.byref(conn)) == 0
            result = Result()
            at = (now+timedelta(seconds=second)).isoformat()
            sql = f"INSERT INTO quota_samples VALUES('synthetic','five_hour','{at}',{used},'{reset}',300,NULL,'fixture')"
            try:
                code = dll.duckdb_query(conn, sql.encode(), ctypes.byref(result))
                assert code == 0, dll.duckdb_result_error(ctypes.byref(result))
            finally:
                dll.duckdb_destroy_result(ctypes.byref(result))
        finally:
            if conn: dll.duckdb_disconnect(ctypes.byref(conn))
            dll.duckdb_close(ctypes.byref(db))
    seed(80)
    settings.write_text(config.replace('notifications = true', 'notifications = false'))
    disabled = command(['quota-notify'])
    assert disabled['state'] == 'disabled' and disabled['shown'] == 0
    result = {'config_off': True}
    if a.native:
        settings.write_text(config)
        first = command(['quota-notify'])
        assert first['shown'] == 1 and first['failed'] == 0, first
        repeated = command(['quota-notify'])
        assert repeated['shown'] == 0 and repeated['failed'] == 0, repeated
        seed(95, 1)
        second = command(['quota-notify'])
        assert second['shown'] == 1 and second['failed'] == 0, second
        restarted = command(['quota-notify'])
        assert restarted['shown'] == 0 and restarted['failed'] == 0, restarted
        result.update({'windows_display_acknowledgements': 2, 'thresholds': [20, 5], 'separate_process_restart_deduplication': True})
    print(json.dumps(result), flush=True)
