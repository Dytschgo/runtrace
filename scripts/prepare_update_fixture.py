"""Build a local-only newer-version fixture without changing the checkout version.

Copies source and optional Cargo cache into a new temporary directory. Nothing is
committed, tagged, published or installed. Used by the isolated update verifier.
"""
import argparse
import hashlib
import os
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib

p = argparse.ArgumentParser()
p.add_argument('--version', default='99.0.0')
cache=p.add_mutually_exclusive_group()
cache.add_argument('--no-cache', action='store_true')
cache.add_argument('--shared-target', action='store_true', help='Reuse Cargo artifacts with a distinct qualification binary name; preserve the checkout executable')
a = p.parse_args()
assert re.fullmatch(r'\d+\.\d+\.\d+', a.version)
source = Path.cwd().resolve()
cargo_target=Path(os.environ.get('CARGO_TARGET_DIR') or source/'target')
if not cargo_target.is_absolute():cargo_target=source/cargo_target
cargo_target=cargo_target.resolve()
original_exe=cargo_target/'release/runtrace.exe'
original_exe_hash=hashlib.sha256(original_exe.read_bytes()).hexdigest() if original_exe.is_file() else None
source_manifest=(source/'Cargo.toml').read_bytes()
source_lock=(source/'Cargo.lock').read_bytes()
original_version = tomllib.loads((source/'Cargo.toml').read_text())['workspace']['package']['version']
assert tuple(map(int,a.version.split('.'))) > tuple(map(int,original_version.split('.')))
root = Path(tempfile.mkdtemp(prefix='runtrace-update-build-'))
for name in ['crates', 'config', 'migrations']:
    shutil.copytree(source/name, root/name)
shutil.copytree(source/'dashboard/dist', root/'dashboard/dist')
manifest = (source/'Cargo.toml').read_text()
(root/'Cargo.toml').write_text(re.sub(r'^version = "[^"]+"', f'version = "{a.version}"', manifest, count=1, flags=re.M))
lock = (source/'Cargo.lock').read_text()
for package in ['runtrace', 't3ui-core']:
    old = f'name = "{package}"\nversion = "{original_version}"'
    assert old in lock
    lock = lock.replace(old, f'name = "{package}"\nversion = "{a.version}"', 1)
(root/'Cargo.lock').write_text(lock)
if not a.no_cache and not a.shared_target:
    for directory in ['deps','build','.fingerprint']:
        cached=cargo_target/'release'/directory
        if cached.exists():shutil.copytree(cached,root/'target/release'/directory)
build_env=os.environ.copy()
build_env['CARGO_TARGET_DIR']=str(root/'target')
build_args=['cargo','build','--release','--locked','--offline','--manifest-path',str(root/'Cargo.toml')]
if a.shared_target:
    cli_manifest=root/'crates/cli/Cargo.toml'
    cli_manifest.write_text(cli_manifest.read_text()+'\n[[bin]]\nname = "runtrace-qualification"\npath = "src/main.rs"\n')
    build_args += ['--bin','runtrace-qualification']
    build_env['CARGO_TARGET_DIR']=str(cargo_target)
print(json.dumps({'scratch':str(root),'version':a.version,'shared_target':a.shared_target}),flush=True)
with (root/'build.log').open('w') as log:
    subprocess.run(build_args,env=build_env,stdout=log,stderr=log,check=True)
if a.shared_target:
    exe=root/'bin/runtrace.exe'
    exe.parent.mkdir()
    shutil.copy2(cargo_target/'release/runtrace-qualification.exe',exe)
else:
    exe=root/'target/release/runtrace.exe'
if (cargo_target/'release/duckdb.dll').is_file():
    shutil.copy2(cargo_target/'release/duckdb.dll',exe.parent/'duckdb.dll')
actual=subprocess.check_output([str(exe),'--version'],text=True).strip()
assert actual == f'runtrace {a.version}',actual
assert (source/'Cargo.toml').read_bytes()==source_manifest
assert (source/'Cargo.lock').read_bytes()==source_lock
assert original_exe_hash is None or hashlib.sha256(original_exe.read_bytes()).hexdigest()==original_exe_hash
print(json.dumps({'fixture_exe':str(exe),'version':a.version,'checkout_artifact_preserved':True}),flush=True)
