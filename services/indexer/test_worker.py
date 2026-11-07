import base64,hashlib,tempfile,os,unittest
from store import Store
from worker import Worker
class Rpc:
 def __init__(self):self.genesis='local';self.height=5;self.status=None;self.sent=[];self.fail=False
 def call(self,method,params):
  if method=='getGenesisHash':return self.genesis
  if method=='getBlockHeight':return self.height
  if method=='simulateTransaction':return {'value':{'err':None}}
  if method=='getSignatureStatuses':return {'value':[self.status for _ in params[0]]}
  if method=='sendTransaction':
   self.sent.append(params[0])
   if self.fail:raise TimeoutError('network timeout')
   return '1'*64
  raise AssertionError(method)
def builder(job):
 message=b'test message';raw=bytes([1])+bytes(64)+message;return {'signature':'1'*64,'wire_transaction':base64.b64encode(raw).decode(),'wire_hash':hashlib.sha256(raw).hexdigest(),'message_hash':hashlib.sha256(message).hexdigest(),'last_valid_height':100}
class WorkerTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.store=Store(os.path.join(self.tmp.name,'db'));self.rpc=Rpc();self.worker=Worker(self.store,self.rpc,builder,'local',clock=lambda:10)
  self.store.ingest('program',1,[],[{'id':'job','kind':'test','launch':'coin','body':{}}],finalized=True)
 def tearDown(self):self.store.db.close();self.tmp.cleanup()
 def phase(self):return self.store.db.execute('SELECT phase FROM jobs').fetchone()[0]
 def test_stale_maintenance_can_finish_without_signature_but_payments_cannot(self):
  self.worker.builder=lambda job:{'noop':'maintenance_already_satisfied'}
  with self.assertRaises(ValueError):self.worker.prepare_one(10)
  self.assertEqual(self.phase(),'queued')
  self.store.db.execute("UPDATE jobs SET kind='keeper_treasury',available_at=0")
  self.worker.prepare_one(10);self.assertEqual(self.phase(),'noop')
  self.assertEqual(self.rpc.sent,[])
 def test_oracle_wait_does_not_exhaust_retries_or_prepare_a_transaction(self):
  self.worker.builder=lambda job:{'deferred':'oracle_fulfillment','retryAfter':10}
  for now in range(10,210,10):
   self.worker.clock=lambda:now
   self.worker.prepare_one(now)
  row=self.store.db.execute('SELECT * FROM jobs').fetchone()
  self.assertEqual(row['phase'],'queued');self.assertEqual(row['attempts'],0)
  self.assertEqual(self.store.db.execute('SELECT count(*) FROM submissions').fetchone()[0],0)
  self.assertEqual(self.rpc.sent,[])
 def test_prepared_before_first_send_then_finalized(self):
  self.worker.prepare_one(10);self.assertEqual(self.phase(),'prepared');self.assertEqual(self.rpc.sent,[])
  self.worker.reconcile();self.assertEqual(self.phase(),'submitted');self.rpc.status={'confirmationStatus':'finalized','err':None};self.worker.reconcile();self.assertEqual(self.phase(),'confirmed')
 def test_timeout_reuses_exact_bytes_and_does_not_resign(self):
  self.worker.prepare_one(10);self.rpc.fail=True
  self.worker.reconcile()
  self.assertEqual(self.phase(),'prepared');self.assertIsNone(self.store.acquire(now=999))
  self.rpc.fail=False;self.worker.reconcile();self.assertEqual(self.rpc.sent[0],self.rpc.sent[1])
 def test_expiry_goes_to_review_without_replacement(self):
  self.worker.prepare_one(10);self.rpc.height=101;self.worker.reconcile();self.assertEqual(self.phase(),'review');self.assertEqual(self.rpc.sent,[])
 def test_wrong_network_never_acquires_or_sends(self):
  self.rpc.genesis='other'
  with self.assertRaises(ValueError):self.worker.prepare_one(10)
  self.assertEqual(self.phase(),'queued');self.assertEqual(self.rpc.sent,[])
 def test_finalized_failure_goes_to_review(self):
  self.worker.prepare_one(10);self.rpc.status={'confirmationStatus':'finalized','err':{'failed':True}};self.worker.reconcile();self.assertEqual(self.phase(),'review')
 def test_confirmed_transaction_not_replaced_even_after_expiry(self):
  self.worker.prepare_one(10);self.rpc.status={'confirmationStatus':'confirmed','err':None};self.rpc.height=101;self.worker.reconcile();self.assertEqual(self.phase(),'prepared');self.assertEqual(self.rpc.sent,[])

 def test_signer_cannot_mislabel_transaction_identity(self):
  def bad(job):
   output=builder(job);output['signature']='other';return output
  self.worker.builder=bad
  with self.assertRaises(ValueError):self.worker.prepare_one(10)
  self.assertEqual(self.phase(),'queued');self.assertEqual(self.rpc.sent,[])
 def test_slow_signer_loses_lease_before_send(self):
  self.worker.clock=lambda:50
  with self.assertRaises(ValueError):self.worker.prepare_one(10)
  self.assertEqual(self.phase(),'working');self.assertEqual(self.rpc.sent,[])
