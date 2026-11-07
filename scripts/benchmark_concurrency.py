"""Exercise bulk retrieval across healthy collector cycles; persist only digests/health."""
import argparse, datetime, hashlib, json, pathlib, time, urllib.error, urllib.request
p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:4310');p.add_argument('--output',required=True);p.add_argument('--cycles',type=int,default=3);p.add_argument('--minimum-requests',type=int,default=60);p.add_argument('--timeout',type=float,default=360);a=p.parse_args()
def get(route):
 with urllib.request.urlopen(a.base+route,timeout=60) as r:return r.read()
start=time.monotonic();started_at=datetime.datetime.now(datetime.timezone.utc).isoformat();rows=[];cycles={};initial=json.loads(get('/health/ready'))['collector'].get('last_successful_sync_at');observed=set();followups=[]
while time.monotonic()-start<a.timeout and (len(rows)<a.minimum_requests or len(cycles)<a.cycles):
 h=json.loads(get('/health/ready'))['collector'];stamp=h.get('last_successful_sync_at');report=h.get('report',{})
 if stamp and stamp!=initial and stamp not in observed:
  observed.add(stamp);healthy=h.get('state')=='synced' and report.get('partial_sync') is False and not report.get('project_errors') and report.get('projects_synced')==report.get('projects_discovered')
  if healthy:cycles[stamp]=h
  print(json.dumps({'completed_cycle':stamp,'healthy':healthy,'duration_ms':h.get('duration_ms'),'healthy_cycles':len(cycles)}),flush=True)
  for route in ['/api/v1/overview','/api/v1/search?q=test&limit=25']:
   try:get(route);followups.append({'route':route,'status':200})
   except urllib.error.HTTPError as e:followups.append({'route':route,'status':e.code})
 route='/api/v1/tool-calls?limit=500&offset=1500&include_content='+('true' if len(rows)%2 else 'false');t=time.perf_counter();row={'request':len(rows),'route':route,'collector_sync_at':stamp}
 try:
  raw=get(route);row.update(status=200,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
 except urllib.error.HTTPError as e:row.update(status=e.code,error=json.loads(e.read()))
 row['ms']=(time.perf_counter()-t)*1000;rows.append(row)
 if len(rows)%20==0 or row['status']!=200:print(json.dumps({'requests':len(rows),'failures':sum(x['status']!=200 for x in rows),'last_ms':row['ms']}),flush=True)
 result={'started_at':started_at,'elapsed_seconds':time.monotonic()-start,'healthy_cycles':cycles,'rows':rows,'followups':followups,'conditions':'512MB production budget; collector active; alternating preview/full; digests contain no content'}
 pathlib.Path(a.output).write_text(json.dumps(result,indent=2))
ok=len(cycles)>=a.cycles and len(rows)>=a.minimum_requests and all(x['status']==200 for x in rows+followups)
print(json.dumps({'passed':ok,'requests':len(rows),'healthy_cycles':len(cycles),'failures':sum(x['status']!=200 for x in rows)}),flush=True)
raise SystemExit(0 if ok else 1)
