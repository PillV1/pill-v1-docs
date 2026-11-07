"""Sequential launch execution and exact, finalized-cost reconciliation."""
import json,re
class Workflows:
 def __init__(self,store):
  self.store=store;self.db=store.db
  from recovery import Recovery
  Recovery(store)
  self.db.executescript('''
CREATE TABLE IF NOT EXISTS launch_plans(intent TEXT PRIMARY KEY REFERENCES intents(id),plan_hash TEXT NOT NULL,stage_count INTEGER NOT NULL,mint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cancellation_costs(job TEXT PRIMARY KEY REFERENCES jobs(id),signature TEXT NOT NULL UNIQUE,net_debit INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_audit(id INTEGER PRIMARY KEY,intent TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS launch_costs(job TEXT PRIMARY KEY REFERENCES jobs(id),signature TEXT NOT NULL UNIQUE,debit INTEGER NOT NULL CHECK(debit>=0));
''')
 def attach(self,intent,plan_hash,stage_count,mint):
  if not re.fullmatch('[a-f0-9]{64}',plan_hash) or type(stage_count) is not int or not 1<=stage_count<=2502:raise ValueError('invalid_plan')
  with self.store.transaction():
   old=self.db.execute('SELECT plan_hash,stage_count,mint FROM launch_plans WHERE intent=?',(intent,)).fetchone()
   if old and tuple(old)!=(plan_hash,stage_count,mint):raise ValueError('plan_conflict')
   self.db.execute('INSERT OR IGNORE INTO launch_plans VALUES(?,?,?,?)',(intent,plan_hash,stage_count,mint))
 def stage_id(self,intent,index):return 'launch-stage:'+intent+':'+str(index).zfill(5)
 def _enqueue(self,intent,index,plan_hash):
  body=json.dumps({'intent':intent,'stage':index,'plan_hash':plan_hash},sort_keys=True,separators=(',',':'))
  self.db.execute('INSERT OR IGNORE INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)',(self.stage_id(intent,index),'launch_stage',intent,body))
 def advance(self):
  with self.store.transaction():
   rows=self.db.execute("SELECT j.id,p.* FROM jobs j JOIN launch_plans p ON p.intent=j.launch JOIN intents i ON i.id=p.intent WHERE j.kind='create_launch' AND j.phase='queued' AND i.state='paid'").fetchall()
   for row in rows:
    self.db.execute("UPDATE jobs SET phase='routed' WHERE id=?",(row['id'],));self._enqueue(row['intent'],0,row['plan_hash'])
   plans=self.db.execute("SELECT p.*,i.expected,i.refund_address,i.owner FROM launch_plans p JOIN intents i ON i.id=p.intent WHERE i.state='paid'").fetchall()
   for plan in plans:
    completed=0;cost=self.db.execute('SELECT COALESCE(SUM(debit),0) FROM failed_attempts WHERE intent=?',(plan['intent'],)).fetchone()[0]
    for index in range(plan['stage_count']):
     job=self.db.execute('SELECT j.phase,c.debit FROM jobs j LEFT JOIN launch_costs c ON c.job=j.id WHERE j.id=?',(self.stage_id(plan['intent'],index),)).fetchone()
     if not job or job['phase']!='confirmed' or job['debit'] is None:break
     completed+=1;cost+=job['debit']
    if cost>plan['expected']:
     self.db.execute("UPDATE intents SET state='review' WHERE id=?",(plan['intent'],))
     self.db.execute("UPDATE jobs SET last_error='launch_budget_exceeded' WHERE id=?",(self.stage_id(plan['intent'],max(0,completed-1)),))
     continue
    if completed==plan['stage_count']:
     self.db.execute("UPDATE intents SET state='launched' WHERE id=?",(plan['intent'],))
     unused=plan['expected']-cost
     if unused:
      body=json.dumps({'intent':plan['intent'],'destination':plan['refund_address'] or plan['owner'],'gross_lamports':unused,'reason':'unused_launch_budget'},sort_keys=True,separators=(',',':'))
      self.db.execute('INSERT INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)',('unused:'+plan['intent'],'refund',plan['intent'],body))
    elif completed>0:self._enqueue(plan['intent'],completed,plan['plan_hash'])
   return len(rows)
 def request_cancel(self,intent,reason,now):
  if not isinstance(reason,str) or not 8<=len(reason)<=500:raise ValueError('recovery_reason_required')
  with self.store.transaction():
   row=self.db.execute('SELECT * FROM intents WHERE id=?',(intent,)).fetchone()
   if not row or row['state'] not in ('paid','review'):raise ValueError('intent_not_cancellable')
   jobs=self.db.execute('SELECT j.*,c.debit FROM jobs j LEFT JOIN launch_costs c ON c.job=j.id WHERE j.launch=?',(intent,)).fetchall()
   # Never cancel across an ambiguous or in-flight signed transaction.
   if any(j['phase'] in ('prepared','submitted','working') or (j['phase']=='review' and j['signature']) for j in jobs):raise ValueError('resolve_inflight_transactions_first')
   stages=[j for j in jobs if j['kind']=='launch_stage']
   if any(j['phase']=='confirmed' and j['debit'] is None for j in stages):raise ValueError('finalized_costs_required')
   cost=sum(j['debit'] for j in stages if j['phase']=='confirmed')+self.db.execute('SELECT COALESCE(SUM(debit),0) FROM failed_attempts WHERE intent=?',(intent,)).fetchone()[0]
   if cost>row['expected']:raise ValueError('launch_budget_exceeded')
   created=any(j['id']==self.stage_id(intent,0) and j['phase']=='confirmed' for j in stages)
   self.db.execute("UPDATE jobs SET phase='cancelled',lease=NULL,lease_until=0 WHERE launch=? AND kind IN ('create_launch','launch_stage') AND phase IN ('queued','review') AND signature IS NULL",(intent,))
   self.db.execute('INSERT INTO recovery_audit(intent,action,reason,created_at) VALUES(?,?,?,?)',(intent,'cancel_requested',reason,now))
   if created:
    self.db.execute("UPDATE intents SET state='cancelling' WHERE id=?",(intent,))
    self.db.execute('INSERT INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)',('cancel:'+intent,'cancel_launch',intent,json.dumps({'intent':intent})))
   else:
    self._finish_cancel(row,cost)
 def _finish_cancel(self,row,cost):
  unused=row['expected']-cost
  if unused<0:raise ValueError('launch_budget_exceeded')
  self.db.execute("UPDATE intents SET state='cancelled' WHERE id=?",(row['id'],))
  if unused:
   body=json.dumps({'intent':row['id'],'destination':row['refund_address'] or row['owner'],'gross_lamports':unused,'reason':'cancelled_launch'},sort_keys=True,separators=(',',':'))
   self.db.execute('INSERT INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)',('cancel-refund:'+row['id'],'refund',row['id'],body))
 def record_cancellation(self,job_id,signature,net_debit):
  if type(net_debit) is not int or abs(net_debit)>9_000_000_000_000_000:raise ValueError('invalid_debit')
  with self.store.transaction():
   job=self.db.execute("SELECT * FROM jobs WHERE id=? AND signature=? AND phase='confirmed' AND kind='cancel_launch'",(job_id,signature)).fetchone()
   if not job:raise ValueError('unconfirmed_cancellation')
   old=self.db.execute('SELECT signature,net_debit FROM cancellation_costs WHERE job=?',(job_id,)).fetchone()
   if old:
    if tuple(old)!=(signature,net_debit):raise ValueError('conflicting_cost')
    return
   row=self.db.execute("SELECT * FROM intents WHERE id=? AND state='cancelling'",(job['launch'],)).fetchone()
   if not row:raise ValueError('cancellation_not_requested')
   spent=self.db.execute("SELECT COALESCE(SUM(c.debit),0) FROM launch_costs c JOIN jobs j ON j.id=c.job WHERE j.launch=?",(row['id'],)).fetchone()[0]
   spent+=self.db.execute('SELECT COALESCE(SUM(debit),0) FROM failed_attempts WHERE intent=?',(row['id'],)).fetchone()[0]
   # A cancellation can return only previously prefunded money; never mint a refund credit.
   if spent+net_debit<0:raise ValueError('invalid_cancellation_credit')
   self.db.execute('INSERT INTO cancellation_costs VALUES(?,?,?)',(job_id,signature,net_debit));self._finish_cancel(row,spent+net_debit)
 def record_cost(self,job_id,signature,debit):
  if type(debit) is not int or not 0<=debit<=9_000_000_000_000_000:raise ValueError('invalid_debit')
  with self.store.transaction():
   job=self.db.execute("SELECT 1 FROM jobs WHERE id=? AND signature=? AND phase='confirmed' AND kind='launch_stage'",(job_id,signature)).fetchone()
   if not job:raise ValueError('unconfirmed_stage')
   old=self.db.execute('SELECT signature,debit FROM launch_costs WHERE job=?',(job_id,)).fetchone()
   if old and tuple(old)!=(signature,debit):raise ValueError('conflicting_cost')
   self.db.execute('INSERT OR IGNORE INTO launch_costs VALUES(?,?,?)',(job_id,signature,debit))

def finalized_stage_cost(rpc,signature,payer,expected_genesis,*,allow_credit=False):
 if rpc.call('getGenesisHash',[])!=expected_genesis:raise ValueError('wrong_network')
 statuses=rpc.call('getSignatureStatuses',[[signature],{'searchTransactionHistory':True}]).get('value',[])
 if len(statuses)!=1 or not statuses[0] or statuses[0].get('confirmationStatus')!='finalized' or statuses[0].get('err') is not None:raise ValueError('finalized_success_required')
 tx=rpc.call('getTransaction',[signature,{'encoding':'json','commitment':'finalized','maxSupportedTransactionVersion':0}])
 if not tx or tx.get('slot')!=statuses[0].get('slot') or tx['transaction']['signatures'][0]!=signature:raise ValueError('transaction_mismatch')
 if tx['transaction']['message']['accountKeys'][0]!=payer or tx['meta']['err'] is not None:raise ValueError('payer_mismatch')
 before=tx['meta']['preBalances'][0];after=tx['meta']['postBalances'][0]
 if type(before) is not int or type(after) is not int or not 0<=before<=9_000_000_000_000_000 or not 0<=after<=9_000_000_000_000_000 or (after>before and not allow_credit):raise ValueError('invalid_payer_balances')
 return before-after
