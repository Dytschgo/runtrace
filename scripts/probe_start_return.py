"""Focused Windows diagnostic: start must return while its detached child stays up."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

p=argparse.ArgumentParser();p.add_argument('--exe',required=True);a=p.parse_args()
original=Path(a.exe).resolve()
env={k:v for k,v in os.environ.items() if not k.startswith(('RUNTRACE_','T3UI_'))}
with tempfile.TemporaryDirectory(prefix='runtrace-start-return-') as directory:
    root=Path(directory);(root/'bin').mkdir();exe=root/'bin/runtrace.exe'
    shutil.copy2(original,exe);shutil.copy2(original.parent/'duckdb.dll',exe.parent/'duckdb.dll')
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    config=Path('config/default.toml').read_text().replace('port = 4310',f'port = {port}').replace('./data/t3-usage.duckdb',(root/'data/fixture.duckdb').as_posix()).replace('./data/archive',(root/'archive').as_posix()).replace('collect_on_serve = true','collect_on_serve = false').replace('notifications = true','notifications = false')+'\n[update]\ncheck = false\n'
    settings=root/'config.toml';settings.write_text(config)
    quote=lambda s:"'"+str(s).replace("'","''")+"'"
    output=root/'start.log'
    script=f"& {{ & {quote(exe)} start --config {quote(settings)}; Write-Output 'START_RETURNED' }} *> {quote(output)}"
    with (root/'host.log').open('w') as host:
        caller=subprocess.Popen(['pwsh','-NoProfile','-Command',script],env=env,stdout=host,stderr=host)
        try:
            began=time.monotonic()
            try:caller.wait(timeout=8);returned=True
            except subprocess.TimeoutExpired:returned=False
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(f'http://127.0.0.1:{port}/health/ready',timeout=3) as r:health=json.load(r)
            with (root/'stop.log').open('w') as log:subprocess.run([str(exe),'stop','--config',str(settings)],env=env,stdout=log,stderr=log,check=True,timeout=30)
            caller.wait(timeout=10)
            marker='START_RETURNED' in output.read_text()
            print(json.dumps({'returned_before_stop':returned,'ready_while_caller_waited':health['ready'],'marker_after_stop':marker,'elapsed_seconds':round(time.monotonic()-began,3)}),flush=True)
            assert returned,'Start kept a redirected PowerShell caller open'
        finally:
            with (root/'stop.log').open('a') as log:subprocess.run([str(exe),'stop','--config',str(settings)],env=env,stdout=log,stderr=log,timeout=30)
            if caller.poll() is None:caller.kill();caller.wait(timeout=10)
