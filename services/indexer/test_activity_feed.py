import unittest,json
from store import Store
from projections import Projections
from pump_market import PumpMarket
from activity_feed import activity_feed
class ActivityTests(unittest.TestCase):
 def setUp(self):
  self.store=Store(':memory:');Projections(self.store);PumpMarket(self.store)
  self.store.db.execute("INSERT INTO coins(launch,mint,creator,treasury,name,symbol,uri,version,phase,created_slot,last_slot,last_sequence) VALUES('launch','mint','creator','treasury','Test','TST','',1,'curve',1,2,1)")
 def tearDown(self):self.store.db.close()
 def event(self,sig,slot,kind,**body):self.store.db.execute('INSERT INTO coin_activity VALUES(?,?,?,?,?,?)',(sig,0,'launch',slot,kind,json.dumps(body)))
 def test_real_launch_and_trade_only(self):
  self.event('a',1,'LaunchCreated');self.event('b',2,'TradeRecorded',trader='buyer',buy=True,tokens='1',quote='100000000');self.event('c',3,'TradeRefused',trader='bad',buy=True,tokens='1',quote='9')
  rows=activity_feed(self.store.db)['items'];self.assertEqual([r['type'] for r in rows],['buy','launch']);self.assertEqual(rows[0]['wallet'],'buyer');self.assertEqual(rows[1]['wallet'],'creator');self.assertEqual(rows[0]['quoteLamports'],'100000000');self.assertIsNone(rows[0]['time'])
 def test_hidden_launch_is_not_broadcast(self):
  self.event('a',1,'LaunchCreated');self.store.db.execute("UPDATE coins SET phase='draft'");self.assertEqual(activity_feed(self.store.db)['items'],[])
 def test_limit_is_bounded(self):
  with self.assertRaises(ValueError):activity_feed(self.store.db,101)
if __name__=='__main__':unittest.main()
