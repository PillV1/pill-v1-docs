"""Bounded finalized deposit polling. Each address advances only after durable credit."""
from receipts import credit_signature
class PaymentIngest:
 def __init__(self,store,payments,rpc,genesis):
  self.store=store;self.payments=payments;self.rpc=rpc;self.genesis=genesis
  store.db.execute('CREATE TABLE IF NOT EXISTS payment_cursors(address TEXT PRIMARY KEY,signature TEXT,last_polled INTEGER NOT NULL DEFAULT 0,last_error TEXT)')
 def poll(self,now,limit=25):
  if type(limit) is not int or not 1<=limit<=100:raise ValueError('invalid_limit')
  self.store.db.execute('INSERT OR IGNORE INTO payment_cursors(address) SELECT deposit_address FROM intents')
  rows=self.store.db.execute('SELECT * FROM payment_cursors WHERE last_polled<? ORDER BY last_polled,address LIMIT ?',(now-10,limit)).fetchall();results=[]
  for row in rows:
   try:
    signatures=[];before=None
    for page in range(10):
     options={'commitment':'finalized','limit':1000}
     if row['signature']:options['until']=row['signature']
     if before:options['before']=before
     batch=self.rpc.call('getSignaturesForAddress',[row['address'],options])
     if not isinstance(batch,list):raise ValueError('invalid_signature_page')
     signatures.extend(batch)
     if len(batch)<1000:break
     before=batch[-1]['signature']
    else:raise ValueError('deposit_history_backpressure')
    for entry in reversed(signatures):
     if entry.get('err') is None:credit_signature(self.payments,self.rpc,entry['signature'],self.genesis)
    newest=signatures[0]['signature'] if signatures else row['signature']
    self.store.db.execute('UPDATE payment_cursors SET signature=?,last_polled=?,last_error=NULL WHERE address=?',(newest,now,row['address']))
    results.append({'address':row['address'],'processed':len(signatures)})
   except Exception as error:
    self.store.db.execute('UPDATE payment_cursors SET last_polled=?,last_error=? WHERE address=?',(now,type(error).__name__,row['address']))
    results.append({'address':row['address'],'error':type(error).__name__})
  return results
