"""Read-only API checks; run while t3ui serve owns the database."""
import json, urllib.request, urllib.error
base='http://127.0.0.1:4310'
for route in ['overview','activity/hourly','models','projects','threads','tool-calls','quota/current','quota/windows','quota/resets','storage','data-quality','search']:
    data=json.load(urllib.request.urlopen(base+'/api/v1/'+route))
    assert isinstance(data,dict), route
for path,headers,status in [('/api/v1/threads?limit=501',{},400),('/api/v1/threads',{'Origin':'https://untrusted.example'},403),('/api/v1/threads',{'Host':'untrusted.example:4310'},403),('/api/v1/unknown',{},404)]:
    try:
        urllib.request.urlopen(urllib.request.Request(base+path,headers=headers))
        raise AssertionError(path)
    except urllib.error.HTTPError as e:
        assert e.code==status,(path,e.code,status)
        assert 'error' in json.load(e)
print('12 API reads and 4 rejection contracts passed')
