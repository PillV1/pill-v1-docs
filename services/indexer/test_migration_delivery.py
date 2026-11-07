"""Durable migration delivery with real SQLite and deliberately failing RPC transport.
Contract execution is covered separately by the deployed-ELF runtime rehearsal.
"""
import base64, hashlib, os, tempfile, unittest
from events import base58
from store import Store
from worker import Worker

class MigrationRpc:
 def __init__(self):
  self.sent=[]; self.statuses={}; self.fail_first=False; self.low_funds=False
 def call(self,method,params):
  if method=='getGenesisHash':return 'local'
  if method=='getBlockHeight':return 10
  if method=='simulateTransaction':return {'value':{'err':'InsufficientFundsForFee' if self.low_funds else None}}
  if method=='getSignatureStatuses':return {'value':[self.statuses.get(s) for s in params[0]]}
  if method=='sendTransaction':
   raw=base64.b64decode(params[0]);sig=base58(raw[1:65]);self.sent.append((sig,params[0]))
   if self.fail_first and raw[1]==1:raise TimeoutError('accepted but response lost')
   return sig
  raise AssertionError(method)

class MigrationDeliveryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.path=os.path.join(self.temp.name,'migration.sqlite')
  self.store=Store(self.path);self.rpc=MigrationRpc();self.builds=0
  self.worker=Worker(self.store,self.rpc,self.build,'local',clock=lambda:100)
 def tearDown(self):self.store.db.close();self.temp.cleanup()
 def build(self,job):
  self.builds+=1
  raw=bytes([1])+bytes([int(job['id'])])*64+b'migration-message'
  return dict(signature=base58(raw[1:65]),wire_transaction=base64.b64encode(raw).decode(),wire_hash=hashlib.sha256(raw).hexdigest(),message_hash=hashlib.sha256(raw[65:]).hexdigest(),last_valid_height=500)
 def seed(self,count=1):
  self.store.ingest('program',10,[],[dict(id=str(i),kind='keeper_graduate',launch='coin'+str(i),body={}) for i in range(1,count+1)],finalized=True)
 def test_restart_after_durable_prepare_reuses_signature_without_resigning(self):
  self.seed();self.worker.prepare_one();self.assertEqual(self.builds,1)
  self.store.db.close();self.store=Store(self.path)
  def never_build(_):raise AssertionError('must not resign pending migration')
  worker=Worker(self.store,self.rpc,never_build,'local',clock=lambda:101)
  worker.reconcile();sig,wire=self.rpc.sent[0]
  worker.reconcile();self.assertEqual(self.rpc.sent[1],(sig,wire))
  self.rpc.statuses[sig]={'confirmationStatus':'finalized','err':None};worker.reconcile()
  self.assertEqual(self.store.health()['phases'],{'confirmed':1})
  self.assertEqual(self.builds,1)
 def test_timeout_for_one_coin_does_not_stop_another_migration(self):
  self.seed(2);self.worker.prepare_one();self.worker.prepare_one();self.rpc.fail_first=True
  self.worker.reconcile()
  self.assertEqual(self.store.health()['phases'],{'prepared':1,'submitted':1})
  self.assertEqual(len(self.rpc.sent),2)
  self.rpc.fail_first=False;self.worker.reconcile()
  self.assertEqual(self.rpc.sent[0],self.rpc.sent[2]);self.assertEqual(self.builds,2)
 def test_insufficient_fee_balance_never_submits_and_recovers_after_funding(self):
  self.seed();self.rpc.low_funds=True
  with self.assertRaisesRegex(ValueError,'simulation_failed'):self.worker.prepare_one()
  self.assertEqual(self.rpc.sent,[])
  self.assertEqual(self.store.db.execute('SELECT count(*) FROM submissions').fetchone()[0],0)
  self.rpc.low_funds=False;self.worker.clock=lambda:103;self.worker.prepare_one();self.worker.reconcile()
  self.assertEqual(self.store.health()['phases'],{'submitted':1})
 def test_duplicate_planner_events_do_not_create_two_jobs(self):
  self.seed();self.seed();self.worker.prepare_one();self.worker.prepare_one()
  self.assertEqual(self.builds,1)
  self.assertEqual(self.store.db.execute('SELECT count(*) FROM jobs').fetchone()[0],1)
 def test_failed_finalized_migration_holds_only_its_own_coin(self):
  self.seed(2);self.worker.prepare_one();self.worker.reconcile()
  sig=self.rpc.sent[0][0];self.rpc.statuses[sig]={'confirmationStatus':'finalized','err':{'InstructionError':[1,'Custom']}}
  self.worker.reconcile();self.worker.prepare_one();self.worker.reconcile()
  self.assertEqual(self.store.health()['phases'],{'review':1,'submitted':1})

if __name__=='__main__':unittest.main()
