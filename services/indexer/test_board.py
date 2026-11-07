import unittest,tempfile,json,os
from store import Store
from projections import Projections
from board import board_page
class BoardTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.s=Store(os.path.join(self.tmp.name,'db'));self.p=Projections(self.s)
  for i in range(130):self.s.db.execute("INSERT INTO coins(launch,mint,creator,treasury,phase,created_slot,last_slot,name,symbol) VALUES(?,?,?,?,'curve',?,?,?,?)",(str(i),'mint'+str(i),'owner','t',i,i,'Coin '+str(i),'C'+str(i)))
 def tearDown(self):self.s.db.close();self.tmp.cleanup()
 def test_numbered_pages_cover_all_rows_once_and_sort_before_pagination(self):
  seen=[]
  for n in range(1,4):
   p=board_page(self.p,n);self.assertEqual(p['pages'],3);self.assertEqual(p['total'],130);self.assertLessEqual(len(p['coins']),48);seen.extend(c['launch'] for c in p['coins'])
  self.assertEqual(len(set(seen)),130)
  self.s.db.execute("INSERT INTO coin_activity VALUES('sell',0,'0',500,'TradeRecorded',?)",(json.dumps({'buy':False}),))
  self.assertEqual(board_page(self.p)['coins'][0]['launch'],'0')
  self.assertEqual(board_page(self.p,sort='new')['coins'][0]['launch'],'129')
  self.assertEqual(board_page(self.p,search='Coin 129')['total'],1)
  self.assertEqual(board_page(self.p,100)['page'],3)
 def test_onepill_shares_page_count_sorting_and_crown(self):
  db=self.s.db;db.executescript('CREATE TABLE onepill_launches(id TEXT,owner TEXT,input TEXT,coin TEXT,created INTEGER,listed_slot INTEGER,state TEXT);CREATE TABLE onepill_market(id TEXT,last_slot INTEGER,cap_sol REAL,progress_bps INTEGER,target_cap_sol REAL,crowned_slot INTEGER,crowned_at INTEGER);')
  db.execute('INSERT INTO onepill_launches VALUES(?,?,?,?,?,?,?)',('one','owner',json.dumps({'name':'OnePill','symbol':'ONE'}),json.dumps({'chains':{'solana':{'token':'mint-one'}}}),1,10,'done'))
  db.execute('INSERT INTO onepill_market VALUES(?,?,?,?,?,?,?)',('one',600,250,10000,202.33,600,1700000000))
  p=board_page(self.p);self.assertEqual(p['total'],131);self.assertTrue(p['coins'][0]['onepill']);self.assertEqual(p['kingOfTheHill']['id'],'one');self.assertEqual(board_page(self.p,sort='cap')['coins'][0]['id'],'one')
if __name__=='__main__':unittest.main()
