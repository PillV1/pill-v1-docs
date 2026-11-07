import unittest,tempfile,os
from store import Store
from payments import Payments
class PaymentTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.s=Store(os.path.join(self.tmp.name,'db'));self.p=Payments(self.s);self.p.create('i','alice','r','deposit',100,1000,'hash',{'mode':'burn'},100)
 def tearDown(self):self.s.db.close();self.tmp.cleanup()
 def receipt(self,amount=100,sig='s',**extra):return dict({'finalized':True,'successful':True,'source_authorized':True,'signature':sig,'instruction_index':0,'sender':'alice','destination':'deposit','amount':amount,'slot':1,'block_time':101},**extra)
 def test_duplicate_deposit_does_not_duplicate_launch(self):
  r=self.receipt();self.p.record(r);self.p.record(r);self.assertEqual(self.s.health()['phases'],{'queued':1});self.assertEqual(self.s.db.execute('SELECT received FROM intents').fetchone()[0],100)
 def test_partial_deposits_and_excess(self):
  self.p.record(self.receipt(40));self.assertEqual(self.s.health()['phases'],{});self.p.record(self.receipt(80,'s2'));self.assertEqual(self.s.health()['phases'],{'queued':2})
 def test_expired_funds_become_refund_work(self):
  self.assertEqual(self.p.record(self.receipt(block_time=1001)),'refund');self.assertEqual(self.s.db.execute('SELECT kind FROM jobs').fetchone()[0],'refund')
 def test_wrong_sender_never_launches_or_auto_refunds(self):
  self.assertEqual(self.p.record(self.receipt(sender='bob')),'review_sender');self.assertEqual(self.s.health()['phases'],{})
 def test_nonfinalized_never_credits(self):
  with self.assertRaises(ValueError):self.p.record(self.receipt(finalized=False))
  self.assertEqual(self.s.db.execute('SELECT received FROM intents').fetchone()[0],0)
 def test_conflicting_replay_rejected(self):
  self.p.record(self.receipt())
  with self.assertRaises(ValueError):self.p.record(self.receipt(101))
 def test_intent_idempotency(self):
  self.assertEqual(self.p.create('different','alice','r','different-address',100,999,'hash',{'mode':'burn'},100)['id'],'i')
  with self.assertRaises(ValueError):self.p.create('x','alice','r','d',200,999,'other',{},100)
 def test_partial_expiry_is_once(self):
  self.p.record(self.receipt(40));self.assertEqual(self.p.expire(1001),1);self.assertEqual(self.p.expire(1002),0);self.assertEqual(self.s.health()['phases'],{'queued':1})
 def test_second_payment_refunded(self):
  self.p.record(self.receipt());self.assertEqual(self.p.record(self.receipt(100,'s2')),'refund');self.assertEqual(self.s.health()['phases'],{'queued':2})
 def test_exchange_deposit_uses_committed_refund_destination(self):
  self.p.create('exchange','alice','exchange-request','exchange-deposit',100,1000,'h',{},100,accept_any_sender=True,refund_address='alice-refund')
  self.assertEqual(self.p.record(self.receipt(150,'exchange-tx',sender='exchange-hot-wallet',destination='exchange-deposit')),'accepted')
  import json
  job=json.loads(self.s.db.execute("SELECT body FROM jobs WHERE id='excess:exchange'").fetchone()[0]);self.assertEqual(job['destination'],'alice-refund');self.assertEqual(job['gross_lamports'],50)
  self.p.record(self.receipt(20,'late',sender='another-exchange',destination='exchange-deposit'))
  job=json.loads(self.s.db.execute("SELECT body FROM jobs WHERE id='refund:late:0'").fetchone()[0]);self.assertEqual(job['destination'],'alice-refund')
 def test_payment_policy_cannot_change_on_replay(self):
  with self.assertRaises(ValueError):self.p.create('i','alice','r','deposit',100,1000,'hash',{'mode':'burn'},100,accept_any_sender=True)
  with self.assertRaises(ValueError):self.p.create('i','alice','r','deposit',100,1000,'hash',{'mode':'burn'},100,refund_address='other')
