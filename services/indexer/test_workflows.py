import json,tempfile,os,unittest
from store import Store
from payments import Payments
from workflows import Workflows,finalized_stage_cost
class WorkflowTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.s=Store(os.path.join(self.tmp.name,'db'));self.p=Payments(self.s);self.w=Workflows(self.s)
  self.p.create('intent','owner','request','deposit',1000,100,'hash',{},0)
  self.w.attach('intent','a'*64,2,'mint')
  self.p.record({'signature':'deposit-tx','instruction_index':0,'sender':'owner','destination':'deposit','amount':1000,'slot':1,'block_time':1,'finalized':True,'successful':True,'source_authorized':True})
 def tearDown(self):self.s.db.close();self.tmp.cleanup()
 def confirm(self,index,cost):
  job=self.w.stage_id('intent',index);sig='tx'+str(index)
  self.s.db.execute("UPDATE jobs SET phase='confirmed',signature=? WHERE id=?",(sig,job));self.w.record_cost(job,sig,cost)
 def test_stages_wait_for_finality_and_exact_cost_then_refund_unused(self):
  self.w.advance();self.assertEqual(self.s.db.execute("SELECT phase FROM jobs WHERE id='launch:intent'").fetchone()[0],'routed')
  self.assertIsNone(self.s.db.execute('SELECT 1 FROM jobs WHERE id=?',(self.w.stage_id('intent',1),)).fetchone())
  self.confirm(0,600);self.w.advance();self.assertIsNotNone(self.s.db.execute('SELECT 1 FROM jobs WHERE id=?',(self.w.stage_id('intent',1),)).fetchone())
  self.confirm(1,100);self.w.advance();self.w.advance()
  refund=self.s.db.execute("SELECT body FROM jobs WHERE id='unused:intent'").fetchone()[0];self.assertEqual(json.loads(refund)['gross_lamports'],300)
  self.assertEqual(self.s.db.execute("SELECT state FROM intents WHERE id='intent'").fetchone()[0],'launched')
 def test_unconfirmed_or_conflicting_cost_is_rejected(self):
  self.w.advance()
  with self.assertRaises(ValueError):self.w.record_cost(self.w.stage_id('intent',0),'bad',1)
  self.confirm(0,600)
  with self.assertRaises(ValueError):self.w.record_cost(self.w.stage_id('intent',0),'tx0',601)
  with self.assertRaises(ValueError):self.w.attach('intent','b'*64,2,'mint')
 def test_budget_overrun_does_not_finish_or_schedule_negative_refund(self):
  self.w.advance();self.confirm(0,1001)
  self.w.advance()
  self.assertEqual(self.s.db.execute("SELECT state FROM intents WHERE id='intent'").fetchone()[0],'review')
  self.assertIsNone(self.s.db.execute("SELECT 1 FROM jobs WHERE id='unused:intent'").fetchone())
 def test_finalized_cost_verifier_binds_payer_and_signature(self):
  class Rpc:
   def call(self,method,params):
    if method=='getGenesisHash':return 'genesis'
    if method=='getSignatureStatuses':return {'value':[{'confirmationStatus':'finalized','err':None,'slot':9}]}
    return {'slot':9,'transaction':{'signatures':['sig'],'message':{'accountKeys':['payer']}},'meta':{'err':None,'preBalances':[1000],'postBalances':[600]}}
  self.assertEqual(finalized_stage_cost(Rpc(),'sig','payer','genesis'),400)
  with self.assertRaises(ValueError):finalized_stage_cost(Rpc(),'sig','other','genesis')
  with self.assertRaises(ValueError):finalized_stage_cost(Rpc(),'wrong','payer','genesis')
 def test_cancel_before_creation_refunds_exact_paid_budget_once(self):
  self.w.request_cancel('intent','User abandoned unopened launch',100)
  row=self.s.db.execute("SELECT body FROM jobs WHERE id='cancel-refund:intent'").fetchone()
  self.assertEqual(json.loads(row[0])['gross_lamports'],1000)
  with self.assertRaises(ValueError):self.w.request_cancel('intent','Repeated cancellation',101)
 def test_partial_cancel_waits_for_contract_and_finalized_net_cost(self):
  self.w.advance();self.confirm(0,600);self.w.advance()
  self.w.request_cancel('intent','Oracle unavailable for unopened launch',100)
  self.assertEqual(self.s.db.execute("SELECT state FROM intents WHERE id='intent'").fetchone()[0],'cancelling')
  with self.assertRaises(ValueError):self.w.record_cancellation('cancel:intent','cancel-sig',-400)
  self.s.db.execute("UPDATE jobs SET phase='confirmed',signature='cancel-sig' WHERE id='cancel:intent'")
  self.w.record_cancellation('cancel:intent','cancel-sig',-400);self.w.record_cancellation('cancel:intent','cancel-sig',-400)
  self.assertEqual(json.loads(self.s.db.execute("SELECT body FROM jobs WHERE id='cancel-refund:intent'").fetchone()[0])['gross_lamports'],800)
  self.assertEqual(self.s.db.execute('SELECT COUNT(*) FROM recovery_audit').fetchone()[0],1)
 def test_cancel_rejects_ambiguous_signed_work_and_missing_costs(self):
  self.w.advance();job=self.w.stage_id('intent',0)
  self.s.db.execute("UPDATE jobs SET phase='review',signature='ambiguous' WHERE id=?",(job,))
  with self.assertRaisesRegex(ValueError,'inflight'):self.w.request_cancel('intent','Do not double spend funds',100)
  self.s.db.execute("UPDATE jobs SET phase='confirmed' WHERE id=?",(job,))
  with self.assertRaisesRegex(ValueError,'costs'):self.w.request_cancel('intent','Need finalized costs first',100)
