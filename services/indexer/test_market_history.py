import unittest,json
from store import Store
from projections import Projections
from pump_market import PumpMarket
from market_history import MarketHistory
class HistoryTests(unittest.TestCase):
 def setUp(self):
  self.store=Store(':memory:');Projections(self.store);PumpMarket(self.store);self.market=MarketHistory(self.store)
 def tearDown(self):self.store.db.close()
 def trade(self,sig,stamp,quote,kind='TradeRecorded'):
  body={'kind':kind,'launch':'launch','trader':'wallet','buy':True,'tokens':'1000000','quote':str(quote),'fee':'0'}
  self.store.db.execute('INSERT INTO coin_activity VALUES(?,?,?,?,?,?)',(sig,0,'launch',10,kind,json.dumps(body)))
  if stamp is not None:self.store.record_time(sig,10,stamp)
 def test_curve_to_pool_chart_and_decimal_volume(self):
  self.trade('a',1000,1000000000);self.trade('b',1010,2000000000)
  self.store.db.execute("INSERT INTO pump_trades VALUES('c',0,'pool','launch',11,1020,'wallet',0,'1000000','500000000')")
  c=self.market.candles('launch')['candles'][0]
  self.assertEqual((c['open'],c['high'],c['low'],c['close']),('1','2','0.5','0.5'));self.assertEqual(c['volumeLamports'],'3500000000');self.assertEqual(c['trades'],3)
 def test_no_fabricated_times_or_failed_buy_volume(self):
  self.trade('a',None,1000000000);self.trade('refused',1000,999999999999,'TradeRefused')
  data=self.market.candles('launch');self.assertEqual(data['candles'],[]);self.assertEqual(data['missingTimestampTrades'],1)
  self.store.record_time('a',10,1000);self.assertEqual(len(self.market.candles('launch')['candles']),1)
 def test_time_replay_conflict_and_summary(self):
  self.trade('a',1000,1000000000);self.store.record_time('a',10,1000)
  with self.assertRaises(ValueError):self.store.record_time('a',10,1001)
  result=self.market.summary('launch',1001);self.assertEqual(result['buys24h'],1);self.assertEqual(result['lastExecutionPriceSol'],'1')
 def test_interval_rejected(self):
  with self.assertRaises(ValueError):self.market.candles('launch',7)
if __name__=='__main__':unittest.main()
