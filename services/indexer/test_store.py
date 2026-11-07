import unittest,tempfile,os
from store import Store
class QueueTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=os.path.join(self.tmp.name,'events.sqlite');self.s=Store(self.path)
 def tearDown(self):self.s.db.close();self.tmp.cleanup()
 def seed(self,n=1):
  e={'program':'p','slot':10,'signature':'sig','event_index':0,'body':{'kind':'launch'}}
  jobs=[{'id':str(i),'kind':'migrate','launch':'coin','body':{'slot':10}} for i in range(n)]
  self.s.ingest('p',10,[e],jobs,finalized=True);return e,jobs
 def test_replay_is_idempotent(self):
  e,j=self.seed();self.s.ingest('p',10,[e],j,finalized=True);self.assertEqual(self.s.db.execute('SELECT COUNT(*) FROM events').fetchone()[0],1);self.assertEqual(self.s.health()['phases'],{'queued':1})
 def test_finality_and_conflicts_rollback(self):
  e,j=self.seed()
  with self.assertRaises(ValueError):self.s.ingest('p',10,[e],j,finalized=False)
  e['body']={'kind':'fake'}
  with self.assertRaises(ValueError):self.s.ingest('p',10,[e],j,finalized=True)
  self.assertEqual(self.s.health()['cursors']['p'],10)
 def test_single_launch_lane(self):
  self.seed(2);self.assertIsNotNone(self.s.acquire(now=100));self.assertIsNone(self.s.acquire(now=101))
 def test_stale_worker_cannot_prepare(self):
  self.seed();a=self.s.acquire(now=100);b=self.s.acquire(now=131)
  with self.assertRaises(ValueError):self.s.prepare(a['id'],a['lease'],'hash','tx','wire',1000,now=132)
  self.s.prepare(b['id'],b['lease'],'hash','tx','wire',1000,now=132)
 def test_prepared_never_automatically_requeued(self):
  self.seed();a=self.s.acquire(now=100);self.s.prepare(a['id'],a['lease'],'hash','tx','wire',1000,now=101);self.assertIsNone(self.s.acquire(now=100000));self.s.submitted(a['id'],'tx');self.assertIsNone(self.s.acquire(now=200000))
 def test_finality_before_confirmation(self):
  self.seed();a=self.s.acquire(now=100);self.s.prepare(a['id'],a['lease'],'hash','tx','wire',1000,now=101)
  with self.assertRaises(ValueError):self.s.confirm(a['id'],'tx',finalized=False,successful=True)
  self.s.confirm(a['id'],'tx',finalized=True,successful=True);self.assertEqual(self.s.health()['phases'],{'confirmed':1})
 def test_persistence_across_restart(self):
  self.seed();self.s.db.close();self.s=Store(self.path);self.assertEqual(self.s.health()['phases'],{'queued':1})
 def test_two_connections_exclusive(self):
  self.seed();other=Store(self.path)
  try:self.assertIsNotNone(self.s.acquire(now=100));self.assertIsNone(other.acquire(now=100))
  finally:other.db.close()
 def test_old_slot_cannot_rewind_cursor(self):
  self.seed();self.s.ingest('p',1,[],[],finalized=True);self.assertEqual(self.s.health()['cursors']['p'],10)
if __name__=='__main__':unittest.main()
