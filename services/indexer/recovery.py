"""Private, evidence-bound recovery. Unknown signed outcomes never authorize retries."""
import json
class Recovery:
 def __init__(self,store):
  self.store=store;self.db=store.db
  self.db.executescript('''CREATE TABLE IF NOT EXISTS failed_attempts(signature TEXT PRIMARY KEY,job TEXT NOT NULL,intent TEXT NOT NULL,debit INTEGER NOT NULL CHECK(debit>=0),evidence TEXT NOT NULL,submission TEXT NOT NULL,created_at INTEGER NOT NULL);''')
 def retry(self,job_id,reason,now,rpc,genesis):
  if not isinstance(reason,str) or not 8<=len(reason)<=500:raise ValueError('recovery_reason_required')
  initial=self.db.execute("SELECT j.*,i.deposit_address,i.state FROM jobs j JOIN intents i ON i.id=j.launch WHERE j.id=? AND j.phase='review' AND j.kind='launch_stage'",(job_id,)).fetchone()
  if not initial or initial['state']!='paid':raise ValueError('job_not_recoverable')
  evidence=None
  if initial['signature']:
   if rpc.call('getGenesisHash',[])!=genesis:raise ValueError('wrong_network')
   sig=initial['signature'];statuses=rpc.call('getSignatureStatuses',[[sig],{'searchTransactionHistory':True}]).get('value',[])
   if len(statuses)!=1 or not statuses[0] or statuses[0].get('confirmationStatus')!='finalized':raise ValueError('signed_outcome_unresolved')
   if statuses[0].get('err') is None:raise ValueError('successful_transaction_reconcile_required')
   tx=rpc.call('getTransaction',[sig,{'encoding':'json','commitment':'finalized','maxSupportedTransactionVersion':0}])
   if not tx or tx.get('slot')!=statuses[0]['slot'] or tx['transaction']['signatures'][0]!=sig or tx['transaction']['message']['accountKeys'][0]!=initial['deposit_address'] or tx['meta']['err']!=statuses[0]['err']:raise ValueError('failed_transaction_mismatch')
   before,after=tx['meta']['preBalances'][0],tx['meta']['postBalances'][0]
   if type(before) is not int or type(after) is not int or not 0<=after<=before<=9_000_000_000_000_000 or before-after!=tx['meta'].get('fee'):raise ValueError('invalid_failed_fee')
   evidence={'slot':tx['slot'],'signature':sig,'payer':initial['deposit_address'],'debit':before-after,'error':tx['meta']['err'],'genesis':genesis}
  with self.store.transaction():
   current=self.db.execute('SELECT phase,signature FROM jobs WHERE id=?',(job_id,)).fetchone()
   if not current or tuple(current)!=('review',initial['signature']):raise ValueError('recovery_race')
   if evidence:
    submission=self.db.execute('SELECT * FROM submissions WHERE job=? AND signature=?',(job_id,initial['signature'])).fetchone()
    if not submission:raise ValueError('signed_submission_required')
    self.db.execute('INSERT INTO failed_attempts VALUES(?,?,?,?,?,?,?)',(initial['signature'],job_id,initial['launch'],evidence['debit'],json.dumps(evidence,sort_keys=True),json.dumps(dict(submission),sort_keys=True),now))
    self.db.execute('DELETE FROM submissions WHERE job=?',(job_id,))
   self.db.execute('INSERT INTO recovery_audit(intent,action,reason,created_at) VALUES(?,?,?,?)',(initial['launch'],'retry:'+job_id,reason,now))
   self.db.execute("UPDATE jobs SET phase='queued',attempts=0,available_at=?,lease=NULL,lease_until=0,signature=NULL,last_error=NULL WHERE id=?",(now,job_id))
