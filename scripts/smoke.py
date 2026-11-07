"""Read-only MCP and HTTP contracts against imported local history. Never prints content."""
import subprocess,json,urllib.request,time,pathlib,os
root=pathlib.Path(__file__).resolve().parent.parent
exe=pathlib.Path(os.environ.get('T3UI_EXECUTABLE',str(root/'target/debug/t3ui.exe')))
def call(method,params=None):
    req={'jsonrpc':'2.0','id':1,'method':method,'params':params or {}}
    p=subprocess.run([str(exe),'mcp','serve'],input=json.dumps(req)+'\n',text=True,encoding='utf-8',capture_output=True,cwd=root,check=True)
    result=json.loads(p.stdout);assert 'error' not in result,result
    return result['result']
assert call('initialize')['serverInfo']['name']=='t3-usage-intelligence'
assert len(call('tools/list')['tools'])==20
result=call('tools/call',{'name':'get_thread_timeline','arguments':{'limit':10}})
records=json.loads(result['content'][0]['text'])['data']
assert records
assert all('content_ciphertext' not in x['data'] for x in records)
print(json.dumps({'mcp_initialize':'pass','tools':20,'timeline_rows':len(records),'full_content':'not exposed'}))

req={'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'search_conversations','arguments':{'scope':'analytics:content-full'}}}
p=subprocess.run([str(exe),'mcp','serve'],input=json.dumps(req)+'\n',text=True,encoding='utf-8',capture_output=True,cwd=root,check=True)
assert 'error' in json.loads(p.stdout), 'Unrecognized full-content authorization must fail closed'
print('MCP full-content scope escalation rejected')
