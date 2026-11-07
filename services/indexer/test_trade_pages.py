import unittest,tempfile,json
from store import Store
from projections import Projections
from pump_market import PumpMarket
from market_history import MarketHistory
class TradePages(unittest.TestCase):
 def test_curve_and_pool_same_slot_pagination_and_cursor_binding(self):
  with tempfile.TemporaryDirectory() as d:
   store=Store(d+'/db');p=Projections(store);PumpMarket(store);h=MarketHistory(store)
   for i in range(5):
    body={'kind':'TradeRecorded','launch':'l','trader':'w','sequence':str(i),'tokens':'1000000','quote':'2000000000','fee':'0','buy':True}
    store.ingest('p',10,[{'program':'p','signature':'s'+str(i),'event_index':0,'slot':10,'body':body}],[],finalized=True)
   p.advance();store.db.execute("INSERT INTO pump_trades VALUES('s5',0,'pool','l',10,1000,'w',0,'1','2')")
   seen=[];cursor=None
   while True:
    data=h.trades_page('l',2,cursor);seen.extend(t['signature'] for t in data['trades']);cursor=data['nextCursor']
    if not cursor:break
    with self.assertRaises(ValueError):h.trades_page('wrong',2,cursor)
   self.assertEqual(seen,['s5','s4','s3','s2','s1','s0']);self.assertEqual(h.trades_page('l',1)['trades'][0]['venue'],'pumpswap');store.db.close()
