"""Generate neutral large tool outputs for first-import memory regression work."""
import argparse
import json
import hashlib
from pathlib import Path
import sqlite3
import tempfile

p = argparse.ArgumentParser()
p.add_argument('--rows', type=int, default=256)
p.add_argument('--bytes-per-row', type=int, default=1024*1024)
p.add_argument('--occurred-at', default='2026-11-01T00:00:00Z')
p.add_argument('--source-id-bytes', type=int, default=0, help='Pad neutral source identities to model upstream key length')
a = p.parse_args()
root = Path(tempfile.mkdtemp(prefix='runtrace-memory-source-'))
source = root/'source.sqlite'
date = a.occurred_at
with sqlite3.connect(source) as c:
    c.executescript('''
CREATE TABLE projection_projects(project_id TEXT,title TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT);
CREATE TABLE orchestration_v2_projection_threads(payload_json TEXT,updated_at TEXT,project_id TEXT);
CREATE TABLE orchestration_v2_projection_runs(payload_json TEXT,requested_at TEXT,completed_at TEXT,thread_id TEXT,ordinal INTEGER);
CREATE TABLE orchestration_v2_projection_messages(payload_json TEXT,updated_at TEXT,message_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,created_at TEXT);
CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,updated_at TEXT,type TEXT,status TEXT,payload_json TEXT);
''')
    c.execute('INSERT INTO projection_projects VALUES(?,?,?,?,NULL)', ('p','Synthetic project',date,date))
    c.execute('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?)', (
        json.dumps({'id':'t','projectId':'p','title':'Synthetic thread','createdAt':date,'updatedAt':date}),date,'p'))
    c.execute('INSERT INTO orchestration_v2_projection_runs VALUES(?,?,?,?,?)', (
        json.dumps({'id':'r','threadId':'t','status':'completed','ordinal':1,'requestedAt':date,'updatedAt':date,'completedAt':date}),date,date,'t',1))
    output = 'x'*a.bytes_per_row
    for n in range(a.rows):
        tid = f'tool-{n}'
        if a.source_id_bytes:
            padding = hashlib.sha256(f'neutral-source-{n}'.encode()).hexdigest()
            tid = (tid + ':' + padding*((a.source_id_bytes//64)+1))[:max(a.source_id_bytes,len(tid))]
        payload = json.dumps({'id':tid,'threadId':'t','runId':'r','type':'command_execution',
                              'status':'completed','startedAt':date,'completedAt':date,
                              'input':{'command':'synthetic read'},'output':output})
        c.execute('INSERT INTO orchestration_v2_projection_turn_items VALUES(?,?,?,?,?,?,?)',
                  (tid,'t','r',date,'command_execution','completed',payload))
print(source)
