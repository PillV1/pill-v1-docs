"""Deposit intent accounting; consumes verified, finalized SOL transfer receipts.
Does not create keys, sign, broadcast, or infer payment from a wallet balance.
"""
import json
class Payments:
 def __init__(self,store):
  self.store=store;self.db=store.db
  self.db.executescript('''
CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL,deposit_address TEXT NOT NULL UNIQUE,expected INTEGER NOT NULL CHECK(expected>0),received INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,params_hash TEXT NOT NULL,params TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'awaiting_payment',UNIQUE(owner,request_id));
CREATE TABLE IF NOT EXISTS deposits(signature TEXT NOT NULL,instruction_index INTEGER NOT NULL,intent TEXT REFERENCES intents(id),sender TEXT NOT NULL,destination TEXT NOT NULL,amount INTEGER NOT NULL,slot INTEGER NOT NULL,disposition TEXT NOT NULL,PRIMARY KEY(signature,instruction_index));
''')
  columns={row[1] for row in self.db.execute('PRAGMA table_info(intents)')}
  if 'accept_any_sender' not in columns:self.db.execute('ALTER TABLE intents ADD COLUMN accept_any_sender INTEGER NOT NULL DEFAULT 0')
  if 'refund_address' not in columns:self.db.execute("ALTER TABLE intents ADD COLUMN refund_address TEXT NOT NULL DEFAULT ''")
 def create(self,id,owner,request_id,address,expected,expires_at,params_hash,params,now,*,accept_any_sender=False,refund_address=None):
  if type(accept_any_sender) is not bool:raise ValueError('invalid_sender_policy')
  refund_address=owner if refund_address is None else refund_address
  if not isinstance(refund_address,str) or not refund_address:raise ValueError('refund_address_required')
  if type(expected) is not int or not 0<expected<=9_000_000_000_000_000:raise ValueError('invalid_amount')
  if type(expires_at) is not int or not now<expires_at<=now+86400:raise ValueError('invalid_expiry')
  encoded=json.dumps(params,sort_keys=True,separators=(',',':'))
  with self.store.transaction():
   old=self.db.execute('SELECT * FROM intents WHERE owner=? AND request_id=?',(owner,request_id)).fetchone()
   if old:
    if old['params_hash']!=params_hash or old['params']!=encoded or old['expected']!=expected or bool(old['accept_any_sender'])!=accept_any_sender or (old['refund_address'] or old['owner'])!=refund_address:raise ValueError('idempotency_conflict')
    return dict(old)
   self.db.execute('INSERT INTO intents(id,owner,request_id,deposit_address,expected,expires_at,params_hash,params) VALUES(?,?,?,?,?,?,?,?)',(id,owner,request_id,address,expected,expires_at,params_hash,encoded))
   self.db.execute('UPDATE intents SET accept_any_sender=?,refund_address=? WHERE id=?',(int(accept_any_sender),refund_address,id))
   return dict(self.db.execute('SELECT * FROM intents WHERE id=?',(id,)).fetchone())
 def record(self,receipt):
  if receipt.get('finalized') is not True or receipt.get('successful') is not True:raise ValueError('successful_finalized_receipt_required')
  if receipt.get('source_authorized') is not True:raise ValueError('source_authorization_required')
  amount=receipt['amount']
  if type(amount) is not int or not 0<amount<=9_000_000_000_000_000:raise ValueError('invalid_amount')
  identity=(receipt['signature'],receipt['instruction_index']);facts=(receipt['sender'],receipt['destination'],amount,receipt['slot'])
  with self.store.transaction():
   old=self.db.execute('SELECT * FROM deposits WHERE signature=? AND instruction_index=?',identity).fetchone()
   if old:
    if (old['sender'],old['destination'],old['amount'],old['slot'])!=facts:raise ValueError('conflicting_receipt')
    return old['disposition']
   intent=self.db.execute('SELECT * FROM intents WHERE deposit_address=?',(receipt['destination'],)).fetchone()
   disposition='unmatched'
   if intent:
    if not intent['accept_any_sender'] and receipt['sender']!=intent['owner']:disposition='review_sender'
    elif receipt['block_time']>intent['expires_at'] or intent['state']!='awaiting_payment':disposition='refund'
    else:disposition='accepted'
   self.db.execute('INSERT INTO deposits VALUES(?,?,?,?,?,?,?,?)',(*identity,intent['id'] if intent else None,*facts,disposition))
   def enqueue(id,kind,body):
    self.db.execute('INSERT INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)',(id,kind,intent['id'],json.dumps(body,sort_keys=True,separators=(',',':'))))
   if disposition=='accepted':
    total=intent['received']+amount
    if total>9_000_000_000_000_000:raise ValueError('deposit_total_overflow')
    funded=total>=intent['expected']
    self.db.execute('UPDATE intents SET received=?,state=? WHERE id=?',(total,'paid' if funded else 'awaiting_payment',intent['id']))
    if funded:
     enqueue('launch:'+intent['id'],'create_launch',{'intent':intent['id'],'params_hash':intent['params_hash'],'params':json.loads(intent['params']),'funded_lamports':intent['expected']})
     if total>intent['expected']:enqueue('excess:'+intent['id'],'refund',{'intent':intent['id'],'destination':intent['refund_address'] or intent['owner'],'gross_lamports':total-intent['expected'],'reason':'excess'})
   elif disposition=='refund':enqueue('refund:'+receipt['signature']+':'+str(receipt['instruction_index']),'refund',{'intent':intent['id'],'destination':intent['refund_address'] or intent['owner'],'gross_lamports':amount,'reason':'expired_or_already_paid'})
   return disposition
 def expire(self,now):
  with self.store.transaction():
   rows=self.db.execute("SELECT * FROM intents WHERE state='awaiting_payment' AND expires_at<?",(now,)).fetchall()
   for r in rows:
    self.db.execute("UPDATE intents SET state='expired' WHERE id=?",(r['id'],))
    if r['received']:
     body=json.dumps({'intent':r['id'],'destination':r['refund_address'] or r['owner'],'gross_lamports':r['received'],'reason':'incomplete_expired'},sort_keys=True,separators=(',',':'))
     self.db.execute('INSERT INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)',('expired:'+r['id'],'refund',r['id'],body))
   return len(rows)
