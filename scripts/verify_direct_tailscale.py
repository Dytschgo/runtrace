"""Test direct HTTPS proxying on a temporary tailnet-only port.

Only adds/removes its own unused Serve port; never resets or replaces existing
handlers. Private hostnames stay in scratch settings, not in the evidence output.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

p=argparse.ArgumentParser()
p.add_argument('--exe',required=True)
p.add_argument('--existing-url',required=True)
a=p.parse_args()
exe=Path(a.exe).resolve()
existing=urllib.parse.urlsplit(a.existing_url)
assert existing.scheme=='https' and existing.hostname
env={k:v for k,v in os.environ.items() if not k.startswith(('RUNTRACE_','T3UI_'))}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def ts(*args):
    return subprocess.check_output(['tailscale','serve',*args],text=True,stderr=subprocess.PIPE,timeout=30)
before=json.loads(ts('status','--json'))
public_port=next(port for port in range(12444,12544) if str(port) not in before.get('TCP',{}))
authority=f'{existing.hostname}:{public_port}'
remote=f'https://{authority}'
def status(url,headers=None):
    try:
        with opener.open(urllib.request.Request(url,headers=headers or {}),timeout=10) as response:
            body=response.read()
            return response.status,body
    except urllib.error.HTTPError as e:return e.code,e.read()
assert status(a.existing_url)[0]==200,'Existing link was not healthy before testing'
with tempfile.TemporaryDirectory(prefix='runtrace-direct-') as directory:
    root=Path(directory)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    config=Path('config/default.toml').read_text().replace('port = 4310',f'port = {port}').replace('./data/t3-usage.duckdb',(root/'data/fixture.duckdb').as_posix()).replace('./data/archive',(root/'archive').as_posix())
    config=config.replace('sqlite_path = ""',f'sqlite_path = "{(root/"absent.sqlite").as_posix()}"').replace('collect_on_serve = true','collect_on_serve = false').replace('checks = true','checks = false').replace('notifications = true','notifications = false')+'\n[update]\ncheck = false\n'
    settings=root/'config.toml';settings.write_text(config)
    log=(root/'serve.log').open('w');service=None;registered=False
    def start():
        global service
        service=subprocess.Popen([str(exe),'serve','--config',str(settings)],env=env,stdout=log,stderr=log)
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            assert service.poll() is None,'Scratch service exited'
            try:
                code,body=status(f'http://127.0.0.1:{port}/health/ready')
                h=json.loads(body)
                assert h['pid']==service.pid,'Unexpected local port owner'
                return h
            except OSError:time.sleep(.1)
        raise AssertionError('Scratch readiness timed out')
    def stop():
        if service and service.poll() is None:service.terminate();service.wait(timeout=15)
    routes=['/','/health/ready','/api/v1/overview','/api/v1/update']
    try:
        first=start()
        ts('--bg','--yes',f'--https={public_port}',f'http://127.0.0.1:{port}')
        registered=True
        for route in routes:assert status(remote+route)[0]==403,(route,'default policy must reject remote authority')
        stop();settings.write_text(config.replace('allowed_hosts = []',f'allowed_hosts = ["{authority}"]'))
        second=start();assert first['storage_identity']==second['storage_identity']
        for route in routes:
            assert status(remote+route,{'Origin':remote})[0]==200,(route,'exact remote authority/origin failed')
            assert status(f'http://127.0.0.1:{port}'+route,{'Host':'unrelated.example.test:12444'})[0]==403
        code,body=status(remote+'/health/ready');assert json.loads(body)['pid']==service.pid
        print(json.dumps({'direct_https_200':True,'direct_process_identity_verified':True,'default_remote_rejections':4,'allowed_host_routes_200':4,'unrelated_host_rejections':4,'uses_relay':False}),flush=True)
    finally:
        if registered:ts('--bg','--yes',f'--https={public_port}','off')
        stop();log.close()
        after=json.loads(ts('status','--json'))
        assert after==before,'Existing Serve configuration changed'
        assert status(a.existing_url)[0]==200,'Existing link was not healthy after cleanup'
        print(json.dumps({'temporary_handler_removed':True,'existing_serve_config_unchanged':True,'existing_link_200':True}),flush=True)
