"""Probe an existing synthetic cold fixture without collection or new imports."""
import argparse
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

p = argparse.ArgumentParser()
p.add_argument('--scratch', required=True)
p.add_argument('--exe')
p.add_argument('--route', action='append')
a = p.parse_args()
root = Path(a.scratch).resolve()
assert root.parent == Path(tempfile.gettempdir()).resolve() and root.name.startswith('runtrace-storage-'), 'Only generated temporary fixtures may be probed'
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
config = (root/'config.toml').read_text()
import re
config = re.sub(r'port = \d+', f'port = {port}', config, count=1)
config = config.replace('collect_on_serve = true', 'collect_on_serve = false')
settings = root/'probe.toml'
settings.write_text(config)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def read(route):
    try:
        with opener.open(f'http://127.0.0.1:{port}'+route, timeout=120) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)
with (root/'probe.log').open('w') as log:
    executable = Path(a.exe).resolve() if a.exe else root/'bin/runtrace.exe'
    service = subprocess.Popen([str(executable), 'serve', '--config', str(settings)], stdout=log, stderr=log)
    try:
        deadline = time.monotonic()+30
        while True:
            assert service.poll() is None
            try:
                code, health = read('/health/ready')
                assert health['pid'] == service.pid
                break
            except OSError:
                assert time.monotonic() < deadline
                time.sleep(.1)
        for route in a.route or ['overview', 'threads?limit=50', 'tool-calls?limit=500', 'tool-calls?limit=500&offset=1500', 'tool-calls?limit=500&include_content=true', 'model-turns?limit=500&shape=lean', 'models', 'usage/projects', 'usage/tools', 'data-quality/fields', 'quota/windows', 'quota/live']:
            start = time.monotonic()
            code, body = read('/api/v1/'+route)
            print(json.dumps({'route':route, 'status':code, 'ms':round((time.monotonic()-start)*1000,1), 'error':body.get('error')}), flush=True)
    finally:
        service.terminate()
        service.wait(timeout=30)
