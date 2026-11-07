"""Prove MCP proxies only to the service owning its configured database."""
import json, os, pathlib, subprocess, time, urllib.request

root = pathlib.Path('D:/Code/Runtrace')
exe = str(root / 'bin/t3ui.exe')
scratch = root / 'benchmarks/mcp-identity'
scratch.mkdir(parents=True, exist_ok=True)
config = (root / 'config/default.toml').read_text(encoding='utf-8-sig')
config = config.replace('port = 4310', 'port = 4312').replace('collect_on_serve = true', 'collect_on_serve = false')
config = config.replace('D:/Code/Runtrace/data/t3-usage.duckdb', str(scratch / 'isolated.duckdb').replace('\\', '/'))
writer_config = scratch / 'writer.toml'
reader_config = scratch / 'wrong-port.toml'
writer_config.write_text(config, encoding='utf-8')
reader_config.write_text(config.replace('port = 4312', 'port = 4310'), encoding='utf-8')
env = dict(os.environ, T3UI_CONFIG=str(writer_config))
env.pop('T3UI_DB', None)
env.pop('T3UI_SOURCE', None)
request = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                      'params': {'name': 'analytics_overview', 'arguments': {}}}) + '\n'
with (scratch / 'server.log').open('w', encoding='utf-8') as log:
    writer = subprocess.Popen([exe, 'serve'], env=env, cwd=root, stdout=log, stderr=log,
                              creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                health = json.load(urllib.request.urlopen('http://127.0.0.1:4312/health/ready', timeout=1))
                assert health['pid'] == writer.pid
                assert health['storage_identity']
                break
            except OSError:
                if time.monotonic() >= deadline or writer.poll() is not None:
                    raise RuntimeError('Isolated identity-test service did not become ready')
                time.sleep(.1)
        matched = subprocess.run([exe, 'mcp', 'serve'], input=request, encoding='utf-8', capture_output=True,
                                 env=env, cwd=root, timeout=15, check=True)
        assert 'result' in json.loads(matched.stdout)
        wrong_env = dict(env, T3UI_CONFIG=str(reader_config))
        rejected = subprocess.run([exe, 'mcp', 'serve'], input=request, encoding='utf-8', capture_output=True,
                                  env=wrong_env, cwd=root, timeout=15)
        assert rejected.returncode != 0
        assert not rejected.stdout.strip(), 'Mismatched service returned content'
        assert 'does not own the configured analytics database' in rejected.stderr
        print('MCP matched-database proxy accepted; wrong-database proxy rejected before returning content')
    finally:
        writer.terminate()
        writer.wait(timeout=10)
