"""Benchmark unchanged imports against one frozen SQLite source. No content output."""
import argparse,ctypes,json,os,pathlib,subprocess,time
p=argparse.ArgumentParser();p.add_argument('--exe',required=True);p.add_argument('--label',required=True);p.add_argument('--source',default='D:/Code/Runtrace/backups/frozen-source/statev2.sqlite');p.add_argument('--runs',type=int,default=3);a=p.parse_args()
root=pathlib.Path(__file__).resolve().parent.parent
dest=pathlib.Path('D:/Code/Runtrace/benchmarks')/a.label;dest.mkdir(parents=True,exist_ok=True)
config=(root/'config/default.toml').read_text().replace('"./data/t3-usage.duckdb"',json.dumps(str(dest/'usage.duckdb'))).replace('"./data/archive"',json.dumps(str(dest/'archive'))).replace('sqlite_path = ""','sqlite_path = '+json.dumps(a.source))
(dest/'config.toml').write_text(config);env=dict(os.environ,T3UI_CONFIG=str(dest/'config.toml'));env.pop('T3UI_DB',None);env.pop('T3UI_SOURCE',None)
class Memory(ctypes.Structure):
 _fields_=[('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong)]+[(n,ctypes.c_size_t)for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
results=[]
for i in range(a.runs):
 start=time.perf_counter();proc=subprocess.Popen([a.exe,'import','--all'],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);peak=0
 while proc.poll() is None:
  if os.name=='nt':
   m=Memory();m.cb=ctypes.sizeof(m)
   if ctypes.windll.psapi.GetProcessMemoryInfo(int(proc._handle),ctypes.byref(m),m.cb):peak=max(peak,m.PeakWorkingSetSize)
  time.sleep(.02)
 stdout,stderr=proc.communicate();elapsed=time.perf_counter()-start
 if proc.returncode: raise RuntimeError(stderr)
 result={'run':i+1,'seconds':round(elapsed,4),'peak_working_set_bytes':peak,'report':json.loads(stdout)};results.append(result);print(json.dumps(result),flush=True)
(dest/'results.json').write_text(json.dumps(results,indent=2))
