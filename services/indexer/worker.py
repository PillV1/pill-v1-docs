"""Durable transaction delivery. Builder/signer is an injected private service.
Persist exact signed bytes before sending. Never create a replacement signature on timeout.
"""
import base64,hashlib,time
from events import base58
class Worker:
 def __init__(self,store,rpc,builder,expected_genesis,clock=time.time):
  if not expected_genesis:raise ValueError('network_required')
  self.store=store;self.rpc=rpc;self.builder=builder;self.genesis=expected_genesis;self.clock=clock
 def check_network(self):
  if self.rpc.call('getGenesisHash',[])!=self.genesis:raise ValueError('wrong_network')
 def prepare_one(self,now=None):
  now=int(self.clock()) if now is None else now
  self.check_network();job=self.store.acquire(now=now)
  if not job:return None
  try:
   prepared=self.builder(job)
   if prepared.get('noop')=='maintenance_already_satisfied':
    self.store.finish_noop(job['id'],job['lease'],now=int(self.clock()));return job['id']
   if 'deferred' in prepared:
    self.store.defer_unsigned(job['id'],job['lease'],prepared['deferred'],prepared['retryAfter'],now=int(self.clock()));return job['id']
   wire=prepared['wire_transaction'];raw=base64.b64decode(wire,validate=True)
   if not 1<=len(raw)<=1232:raise ValueError('invalid_transaction_size')
   if hashlib.sha256(raw).hexdigest()!=prepared['wire_hash']:raise ValueError('wire_hash_mismatch')
   count=0;offset=0
   for shift in (0,7,14):
    if offset>=len(raw):raise ValueError('invalid_signature_header')
    byte=raw[offset];offset+=1;count|=(byte&127)<<shift
    if byte<128:break
   else:raise ValueError('invalid_signature_header')
   if not 1<=count<=16 or len(raw)<=offset+64*count:raise ValueError('invalid_signature_count')
   if base58(raw[offset:offset+64])!=prepared['signature']:raise ValueError('signature_wire_mismatch')
   message=raw[offset+64*count:]
   if hashlib.sha256(message).hexdigest()!=prepared['message_hash']:raise ValueError('message_hash_mismatch')
   height=prepared['last_valid_height']
   if type(height) is not int or height<=self.rpc.call('getBlockHeight',[{'commitment':'finalized'}]):raise ValueError('expired_transaction')
   # RPC verifies signatures during simulation, before the durable send state is entered.
   simulation=self.rpc.call('simulateTransaction',[wire,{'encoding':'base64','sigVerify':True,'commitment':'confirmed'}])
   if not isinstance(simulation,dict) or not isinstance(simulation.get('value'),dict) or 'err' not in simulation['value'] or simulation['value']['err'] is not None:raise ValueError('simulation_failed')
   self.store.prepare(job['id'],job['lease'],prepared['message_hash'],prepared['signature'],wire,height,now=int(self.clock()))
  except Exception as error:
   # A failure after durable prepare must never return the job to the unsigned queue.
   current=self.store.db.execute('SELECT phase,lease,lease_until FROM jobs WHERE id=?',(job['id'],)).fetchone()
   if current and current['phase']=='working' and current['lease']==job['lease'] and current['lease_until']>=int(self.clock()):self.store.retry_unsigned(job['id'],job['lease'],type(error).__name__,now=int(self.clock()))
   raise
  return job['id']
 def reconcile(self,limit=100):
  self.check_network()
  if not 1<=limit<=256:raise ValueError('invalid_batch_limit')
  rows=self.store.db.execute("SELECT j.id,j.phase,s.* FROM jobs j JOIN submissions s ON s.job=j.id WHERE j.phase IN ('prepared','submitted') ORDER BY s.created_at,j.id LIMIT ?",(limit,)).fetchall()
  if not rows:return 0
  response=self.rpc.call('getSignatureStatuses',[[r['signature'] for r in rows],{'searchTransactionHistory':True}])
  values=response.get('value',[])
  if len(values)!=len(rows):raise ValueError('status_count_mismatch')
  height=self.rpc.call('getBlockHeight',[{'commitment':'finalized'}])
  for row,status in zip(rows,values):
   if status and status.get('confirmationStatus')=='finalized':
    self.store.confirm(row['id'],row['signature'],finalized=True,successful=status.get('err') is None);continue
   if status:continue # processed/confirmed observations are not terminal or permission to replace
   if height>row['last_valid_height']:
    # Conservative review: no automatic re-signing or balance-based assumptions.
    with self.store.transaction():
     self.store.db.execute("UPDATE jobs SET phase='review',last_error='expired_without_finalized_status' WHERE id=? AND phase IN ('prepared','submitted')",(row['id'],))
    continue
   try:
    returned=self.rpc.call('sendTransaction',[row['wire_transaction'],{'encoding':'base64','skipPreflight':False,'preflightCommitment':'confirmed','maxRetries':0}])
    if returned!=row['signature']:raise ValueError('rpc_signature_mismatch')
    self.store.submitted(row['id'],returned)
   except Exception as error:
    # Keep the durable signed bytes: a timeout can occur after the RPC accepted
    # the transaction. Isolate this coin so other migrations can still progress.
    self.store.heartbeat('delivery:'+row['id'],type(error).__name__,now=int(self.clock()))
    continue
   self.store.heartbeat('delivery:'+row['id'],now=int(self.clock()))
  return len(rows)
