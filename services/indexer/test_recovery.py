import json,unittest
from store import Store
from payments import Payments
from workflows import Workflows
from recovery import Recovery
class RecoveryTests(unittest.TestCase):
 def setUp(self):
  self.s=Store(':memory:');Payments(self.s).create('intent','owner','request','deposit',1000,100,'hash',{},0);self.w=Workflows(self.s);self.r=Recovery(self.s)
  self.s.db.execute("UPDATE intents SET state='paid'")
  self.s.db.execute("INSERT INTO jobs(id,kind,launch,body,phase,signature) VALUES('stage','launch_stage','intent','{}','review','sig')")
  self.s.db.execute("INSERT INTO submissions VALUES('stage','hash','sig','wire',100,1)")
 def tearDown(self):self.s.db.close()
 def rpc(self,status='failed'):
  class Rpc:
   def call(self,method,params):
    if method=='getGenesisHash':return 'genesis'
    if method=='getSignatureStatuses':return {'value':[None if status=='unknown' else {'slot':1,'confirmationStatus':'finalized','err':None if status=='success' else 'Failed'}]}
    return {'slot':1,'transaction':{'signatures':['sig'],'message':{'accountKeys':['deposit']}},'meta':{'err':'Failed','fee':5,'preBalances':[1000],'postBalances':[995]}}
  return Rpc()
 def test_failed_retry_archives_signed_bytes_and_charges_failed_network_fee(self):
  self.r.retry('stage','Resolved failed instruction',100,self.rpc(),'genesis')
  self.assertEqual(self.s.db.execute('SELECT phase,signature FROM jobs').fetchone()[:],('queued',None))
  row=self.s.db.execute('SELECT debit,submission FROM failed_attempts').fetchone();self.assertEqual(row[0],5);self.assertEqual(json.loads(row[1])['wire_transaction'],'wire')
  self.assertEqual(self.s.db.execute('SELECT COUNT(*) FROM submissions').fetchone()[0],0)
  self.w.request_cancel('intent','Cancel before creating mint',101)
  self.assertEqual(json.loads(self.s.db.execute("SELECT body FROM jobs WHERE kind='refund'").fetchone()[0])['gross_lamports'],995)
 def test_unknown_successful_and_wrong_network_never_authorize_replacement(self):
  for status in ['unknown','success']:
   with self.assertRaises(ValueError):self.r.retry('stage','Must not repeat a payment',100,self.rpc(status),'genesis')
  with self.assertRaisesRegex(ValueError,'network'):self.r.retry('stage','Must bind network first',100,self.rpc(),'other')
  self.assertEqual(self.s.db.execute('SELECT COUNT(*) FROM submissions').fetchone()[0],1)
 def test_unsigned_review_can_retry_without_network_or_fee_claims(self):
  self.s.db.execute('DELETE FROM submissions');self.s.db.execute('UPDATE jobs SET signature=NULL')
  self.r.retry('stage','Resolved local build error',100,None,'genesis')
  self.assertEqual(self.s.db.execute('SELECT COUNT(*) FROM failed_attempts').fetchone()[0],0)
