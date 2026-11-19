"""Exercise a real executable replacement against a local-only release fixture.

Uses a NEW install, synthetic data, unused ports and the install's start/stop
scripts. No registry entry or installed Runtrace database is touched.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument('--exe', required=True)
p.add_argument('--candidate', required=True)
p.add_argument('--standalone', action='store_true', help='Prove the statically bundled executable needs no separate DuckDB DLL')
a = p.parse_args()
original = Path(a.exe).resolve()
candidate = Path(a.candidate).resolve()
env = {k: v for k, v in os.environ.items() if not k.startswith(('RUNTRACE_', 'T3UI_'))}
env['RUNTRACE_NOW'] = '2026-11-08T13:37:00Z'
old_version = subprocess.check_output([str(original), '--version'], env=env, text=True).strip().split()[-1]
new_version = subprocess.check_output([str(candidate), '--version'], env=env, text=True).strip().split()[-1]
assert tuple(map(int,new_version.split('.'))) > tuple(map(int,old_version.split('.')))
asset = 'runtrace-x86_64-pc-windows-msvc.exe'
binary = candidate.read_bytes()
sums = (hashlib.sha256(binary).hexdigest()+'  '+asset+'\n').encode()
bad_checksum = False
class Release(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        base = f'http://127.0.0.1:{self.server.server_port}'
        if self.path.endswith('/releases/latest'):
            data = json.dumps({'tag_name':'v'+new_version,'html_url':base+'/fixture','body':'Neutral local update qualification','assets':[{'name':asset,'browser_download_url':base+'/asset'},{'name':'SHA256SUMS','browser_download_url':base+'/sums'}]}).encode()
        elif self.path == '/asset':data = binary
        elif self.path == '/sums':data = (b'0'*64+b'  '+asset.encode()+b'\n') if bad_checksum else sums
        else:self.send_error(404);return
        self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Release)
threading.Thread(target=server.serve_forever,daemon=True).start()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with tempfile.TemporaryDirectory(prefix='runtrace-update-check-') as directory:
    root = Path(directory)
    for name in ['bin','data','config']: (root/name).mkdir()
    exe = root/'bin/runtrace.exe'
    shutil.copy2(original,exe)
    if not a.standalone and (original.parent/'duckdb.dll').is_file():
        shutil.copy2(original.parent/'duckdb.dll',exe.parent/'duckdb.dll')
    for name in ['start.ps1','stop.ps1']:shutil.copy2(Path('scripts')/name,root/name)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    config = Path('config/default.toml').read_text().replace('port = 4310',f'port = {port}').replace('./data/t3-usage.duckdb',(root/'data/fixture.duckdb').as_posix()).replace('./data/archive',(root/'archive').as_posix())
    config = config.replace('sqlite_path = ""',f'sqlite_path = "{(root/"absent.sqlite").as_posix()}"').replace('collect_on_serve = true','collect_on_serve = false').replace('checks = true','checks = false').replace('notifications = true','notifications = false')
    config += f'\n[update]\ncheck = false\nrepo = "neutral/fixture"\napi_base = "http://127.0.0.1:{server.server_port}"\n'
    settings = root/'config/default.toml';settings.write_text(config)
    def command(args, success=True):
        with (root/'command.log').open('w') as log:
            result = subprocess.run(args,env=env,stdout=log,stderr=log,timeout=120,creationflags=0x08000000 if os.name=='nt' else 0)
        if success:assert result.returncode == 0,(root/'command.log').read_text()
        return result.returncode
    def cli(*args,success=True):return command([str(exe),*args,'--config',str(settings)],success)
    def script(name):return command(['powershell.exe','-NoProfile','-NonInteractive','-File',str(root/name)])
    def read(route):
        with opener.open(f'http://127.0.0.1:{port}'+route,timeout=10) as response:return json.load(response)
    def digest(route):return hashlib.sha256(json.dumps(read(route),sort_keys=True,separators=(',',':')).encode()).hexdigest()
    try:
        cli('fixture','--now',env['RUNTRACE_NOW'])
        cli('archive','compact')
        cli('storage','stats');original_stats=json.loads((root/'command.log').read_text())
        assert original_stats['cold_segments'] > 0
        script('start.ps1')
        before=read('/health/ready');assert before['version']==old_version
        routes=['overview','threads?limit=50','quota/windows','usage/tools']
        baseline={r:digest('/api/v1/'+r) for r in routes}
        executable_hash=hashlib.sha256(exe.read_bytes()).hexdigest()
        bad_checksum=True
        assert cli('update','--yes',success=False) != 0
        assert read('/health/ready')['pid']==before['pid']
        assert hashlib.sha256(exe.read_bytes()).hexdigest()==executable_hash
        bad_checksum=False
        blocker=root/'backups'
        assert not blocker.exists()
        blocker.write_text('Neutral backup failure fixture')
        try:
            assert cli('update','--yes',success=False) != 0
            recovered=read('/health/ready')
            assert recovered['version']==old_version and recovered['storage_identity']==before['storage_identity']
            assert hashlib.sha256(exe.read_bytes()).hexdigest()==executable_hash
        finally:
            blocker.unlink()
        began=time.monotonic();cli('update','--yes')
        after=read('/health/ready')
        assert after['version']==new_version and after['pid']!=before['pid']
        assert after['storage_identity']==before['storage_identity']
        if a.standalone:
            assert not (exe.parent/'duckdb.dll').exists()
            probe="$ErrorActionPreference='Stop'; @(Get-Process -Id "+str(int(after['pid']))+" -Module | Where-Object ModuleName -Like 'duckdb*.dll').Count"
            modules=subprocess.check_output(['powershell.exe','-NoProfile','-NonInteractive','-Command',probe],env=env,text=True,creationflags=0x08000000 if os.name=='nt' else 0)
            assert int(modules.strip())==0, 'Standalone update unexpectedly loaded a DuckDB DLL'
        assert baseline=={r:digest('/api/v1/'+r) for r in routes}
        assert hashlib.sha256(exe.read_bytes()).digest()==hashlib.sha256(binary).digest()
        backups=list((root/'backups').glob('before-update-*'))
        assert len(backups)==1 and (backups[0]/'database/fixture.duckdb').is_file()
        script('stop.ps1');time.sleep(3)
        backup_config=root/'config/backup.toml'
        backup_config.write_text(config.replace((root/'data/fixture.duckdb').as_posix(),(backups[0]/'database/fixture.duckdb').as_posix()).replace((root/'archive').as_posix(),(backups[0]/'restore-maintenance').as_posix()))
        # A database-only copy must not borrow the installation's cold files.
        original_archive=root/'archive'
        hidden_archive=root/'archive-unavailable-for-backup-restore'
        original_archive.rename(hidden_archive)
        try:
            command([str(original),'archive','verify','--config',str(backup_config)])
            command([str(original),'storage','stats','--config',str(backup_config)])
            restored=json.loads((root/'command.log').read_text())
            assert restored['rows']==original_stats['rows'] and restored['events']==original_stats['events']
            command([str(original),'start','--config',str(backup_config)])
            try:
                assert baseline=={r:digest('/api/v1/'+r) for r in routes}
            finally:
                command([str(original),'stop','--config',str(backup_config)])
        finally:
            hidden_archive.rename(original_archive)
        cli('status','--json');assert json.loads((root/'command.log').read_text())['state']=='stopped'
        script('start.ps1');assert read('/health/ready')['version']==new_version
        print(json.dumps({'from_version':old_version,'to_version':new_version,'update_cycle_seconds':round(time.monotonic()-began,3),'checksum_rejected_without_stop_or_replacement':True,'backup_failure_restarts_previous_service':True,'same_database':True,'exact_api_digests':len(routes),'backup_created_and_verified':True,'backup_survives_missing_original_segments':True,'cold_segments':original_stats['cold_segments'],'start_stop_scripts_after_update':True,'same_candidate_bytes':True,'standalone_without_duckdb_dll':True if a.standalone else None}),flush=True)
    finally:
        script('stop.ps1')
        server.shutdown();server.server_close()
