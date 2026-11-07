"""Read-only finalized history ingestion. Explicit program/RPC configuration required."""
import argparse,json,os,time,urllib.request,urllib.error
from store import Store
from events import transaction_events
from projections import Projections
from pump_market import PumpMarket
from refusals import blocked_buy
class Rpc:
 def __init__(self,url):
  if not url.startswith(('https://','http://127.0.0.1:')):raise ValueError('https_rpc_required')
  self.url=url
  self.genesis=None;self.genesis_until=0
 def call(self,method,params):
  # Genesis is immutable for this fixed endpoint; avoid paying for it every poll.
  if method=='getGenesisHash' and params==[] and self.genesis is not None and time.monotonic()<self.genesis_until:return self.genesis
  body=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
  for attempt in range(4):
   try:
    with urllib.request.urlopen(urllib.request.Request(self.url,data=body,headers={'Content-Type':'application/json'}),timeout=20) as r:
     raw=r.read(8*1024*1024+1)
     if len(raw)>8*1024*1024:raise ValueError('rpc_response_too_large')
     result=json.loads(raw)
     if result.get('error'):raise RuntimeError('rpc_error')
     value=result['result']
     if method=='getGenesisHash' and params==[] and isinstance(value,str):
      self.genesis=value;self.genesis_until=time.monotonic()+300
     return value
   except (urllib.error.URLError,TimeoutError,RuntimeError):
    if attempt==3:raise
    time.sleep(min(4,2**attempt))
def ingest_once(store,rpc,program):
 store.db.execute('CREATE TABLE IF NOT EXISTS signature_cursors(program TEXT PRIMARY KEY,signature TEXT NOT NULL)')
 row=store.db.execute('SELECT signature FROM signature_cursors WHERE program=?',(program,)).fetchone();stop=row[0] if row else None
 entries=[];before=None
 # A bounded catch-up batch. Reaching the cap does not skip unseen history.
 for page in range(10):
  options={'limit':1000,'commitment':'finalized'}
  if before:options['before']=before
  if stop:options['until']=stop
  batch=rpc.call('getSignaturesForAddress',[program,options]);entries.extend(batch)
  if len(batch)<1000:break
  before=batch[-1]['signature']
 else:raise RuntimeError('backlog_exceeds_batch_budget')
 for e in reversed(entries):
  if e.get('confirmationStatus')!='finalized':raise RuntimeError('signature_not_finalized')
  data=rpc.call('getTransaction',[e['signature'],{'encoding':'json','commitment':'finalized','maxSupportedTransactionVersion':0}])
  if not data or data.get('transaction',{}).get('signatures',[None])[0]!=e['signature']:raise RuntimeError('transaction_identity_mismatch')
  events=transaction_events(program,e['signature'],data,finalized=True)
  if data.get('meta',{}).get('err') is not None:events=blocked_buy(program,e['signature'],data)
  if data['slot']!=e['slot']:raise RuntimeError('slot_mismatch')
  # Persist events first. A crash before the cursor write replays safely.
  store.ingest(program,data['slot'],events,[],finalized=True)
  if type(data.get('blockTime')) is int:store.record_time(e['signature'],data['slot'],data['blockTime'])
  store.db.execute('INSERT INTO signature_cursors VALUES(?,?) ON CONFLICT(program) DO UPDATE SET signature=excluded.signature',(program,e['signature']))
 projection=Projections(store)
 for _ in range(100):
  if projection.advance()<1000:break
 # Backfill older indexed trades from chain time; never invent timestamps.
 for row in store.db.execute("SELECT DISTINCT a.signature,a.slot FROM coin_activity a LEFT JOIN transaction_times t ON t.signature=a.signature WHERE a.kind='TradeRecorded' AND t.signature IS NULL ORDER BY a.slot DESC LIMIT 100").fetchall():
  stamp=rpc.call('getBlockTime',[row['slot']])
  if stamp is not None:store.record_time(row['signature'],row['slot'],stamp)
 return len(entries)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--program',required=True);p.add_argument('--database',required=True);p.add_argument('--genesis',required=True);p.add_argument('--once',action='store_true');a=p.parse_args()
 rpc=Rpc(os.environ['LAUNCHPAD_RPC_URL']);store=Store(a.database);market=PumpMarket(store)
 while True:
  try:
   if rpc.call('getGenesisHash',[])!=a.genesis:raise ValueError('wrong_network')
   count=ingest_once(store,rpc,a.program);market.poll(rpc,a.genesis,int(time.time()));store.heartbeat('indexer');print(json.dumps({'indexed':count,'health':store.health()}),flush=True)
  except Exception as e:store.heartbeat('indexer',type(e).__name__);print(json.dumps({'error':type(e).__name__,'ready':False}),flush=True)
  if a.once:break
  time.sleep(5)
