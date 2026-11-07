import tempfile,os,unittest
from store import Store
from projections import Projections
class ProjectionTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.s=Store(os.path.join(self.tmp.name,'db'));self.p=Projections(self.s)
 def tearDown(self):self.s.db.close();self.tmp.cleanup()
 def event(self,index,body):return {'program':'program','signature':'sig','event_index':index,'slot':10,'body':{'launch':'launch',**body}}
 def test_replay_does_not_duplicate_volume_or_coins(self):
  events=[self.event(0,{'kind':'LaunchCreated','mint':'mint','creator':'owner','treasury':'treasury'}),self.event(1,{'kind':'TradeRecorded','sequence':'1','quote':'100','fee':'3'})]
  self.s.ingest('program',10,events,[],finalized=True);self.assertEqual(self.p.advance(),2);self.assertEqual(self.p.advance(),0)
  self.s.ingest('program',10,events,[],finalized=True);self.p.advance();self.assertEqual(self.p.stats()['curveVolumeLamports'],'100');self.assertEqual(len(self.p.coins()),1)
 def test_graduation_and_payout_activity(self):
  events=[self.event(0,{'kind':'LaunchCreated','mint':'mint','creator':'owner','treasury':'treasury'}),self.event(1,{'kind':'Graduated','pool':'pool'}),self.event(2,{'kind':'CoinFeesUsed','mode':'holders','quote':'12','tokens':'0'})]
  self.s.ingest('program',10,events,[],finalized=True);self.p.advance();self.assertEqual(self.p.coins()[0]['phase'],'pumpswap');self.assertEqual(self.p.stats()['holderRewardsLamports'],'12');self.assertEqual(len(self.p.activity('launch')),3)
 def test_batch_cursor_catches_up_without_skipping(self):
  self.s.ingest('program',10,[self.event(0,{'kind':'LaunchCreated','mint':'mint','creator':'owner','treasury':'treasury'}),self.event(1,{'kind':'TreasuryPaid','amount':'1'})],[],finalized=True)
  self.assertEqual(self.p.advance(1),1);self.assertEqual(self.p.advance(1),1);self.assertEqual(len(self.p.activity('launch')),2)
 def test_same_slot_coins_paginate_without_loss(self):
  events=[self.event(i,{'kind':'LaunchCreated','launch':str(i),'mint':'mint'+str(i),'creator':'owner','treasury':'treasury'}) for i in range(11)]
  self.s.ingest('program',10,events,[],finalized=True);self.p.advance();seen=[];cursor=None
  while True:
   page=self.p.coins_page(3,cursor);seen.extend(x['launch'] for x in page['coins']);cursor=page['nextCursor']
   if cursor is None:break
  self.assertEqual(len(seen),11);self.assertEqual(len(set(seen)),11)
 def test_same_slot_activity_cursor_binds_coin_and_filter(self):
  events=[self.event(i,{'kind':'TreasuryPaid','amount':str(i)}) for i in range(8)]
  self.s.ingest('program',10,events,[],finalized=True);self.p.advance();page=self.p.activity_page('launch',3)
  next_page=self.p.activity_page('launch',3,page['nextCursor'])
  self.assertEqual([x['event_index'] for x in page['activity']+next_page['activity']],list(range(6)))
  with self.assertRaises(ValueError):self.p.activity_page('other',3,page['nextCursor'])
 def test_cursor_validation_rejects_unbounded_or_wrong_types(self):
  from projections import encode_cursor
  for cursor in ['!', 'a'*513,encode_cursor('coins',[True,'x','']),encode_cursor('coins',[2**100,'x','']),encode_cursor('activity',[1,'x',0,'launch'])]:
   with self.assertRaises(ValueError):self.p.coins_page(cursor=cursor)
  with self.assertRaises(ValueError):self.p.coins_page(cursor=encode_cursor('coins',[1,'x','curve']),phase='pumpswap')
 def test_unknown_coin_is_absent_and_pages_reject_unbounded_limits(self):
  self.assertIsNone(self.p.coin('unknown'))
  for limit in [0,101,True,1.5]:
   with self.assertRaises(ValueError):self.p.coins_page(limit)
 def test_metadata_published_and_renamed_without_changing_coin_identity(self):
  events=[self.event(0,{'kind':'LaunchCreated','mint':'mint','creator':'owner','treasury':'treasury'}),self.event(1,{'kind':'TokenMetadataPublished','name':'Original','symbol':'TEST','uri':'ipfs://original'}),self.event(2,{'kind':'TokenMetadataPublished','name':'Renamed','symbol':'TEST','uri':'ipfs://renamed'})]
  self.s.ingest('program',10,events,[],finalized=True);self.p.advance();coin=self.p.coin('launch')
  self.assertEqual(coin['name'],'Renamed');self.assertEqual(coin['uri'],'ipfs://renamed');self.assertEqual(coin['mint'],'mint');self.assertEqual(len(self.p.activity('launch')),3)
 def test_classic_becomes_tradeable_without_vrf_and_keeps_version(self):
  events=[self.event(0,{'kind':'LaunchCreated','mint':'mint','creator':'owner','treasury':'treasury'}),self.event(1,{'kind':'LaunchVersionSelected','mint':'mint','version':1})]
  self.s.ingest('program',10,events,[],finalized=True);self.p.advance();coin=self.p.coin('launch');self.assertEqual(coin['version'],1);self.assertEqual(coin['phase'],'curve')
 def test_enhanced_stays_pending_until_activation(self):
  events=[self.event(0,{'kind':'LaunchCreated','mint':'mint','creator':'owner','treasury':'treasury'}),self.event(1,{'kind':'LaunchVersionSelected','mint':'mint','version':11})]
  self.s.ingest('program',10,events,[],finalized=True);self.p.advance();coin=self.p.coin('launch');self.assertEqual(coin['version'],11);self.assertEqual(coin['phase'],'pending')
 def test_crown_exact_boundary_persists_after_sell_and_rotates_once(self):
  sale=793100000000000;threshold=sale*85//100
  def push(index,launch,body):
   e=self.event(index,{'launch':launch,**body});self.s.ingest('program',10,[e],[],finalized=True);self.p.advance()
  for i,l in enumerate(['a','b']):
   push(i*2,l,{'kind':'LaunchCreated','mint':'mint'+l,'creator':'owner','treasury':'treasury'})
   push(i*2+1,l,{'kind':'LaunchVersionSelected','mint':'mint'+l,'version':1})
  def trade(i,l,tokens,buy=True):push(i,l,{'kind':'TradeRecorded','sequence':str(i),'quote':'1','fee':'0','tokens':str(tokens),'buy':buy})
  trade(4,'a',threshold-1);self.assertIsNone(self.p.king_of_the_hill())
  self.assertFalse(self.p.coin('a')['kingOfTheHill']['qualified'])
  trade(5,'a',1);self.s.record_time('sig',10,1700000000)
  self.assertEqual(self.p.king_of_the_hill()['launch'],'a')
  self.assertEqual(self.p.coin('a')['kingOfTheHill']['crownedAt'],1700000000)
  trade(6,'a',100,False);self.assertEqual(self.p.king_of_the_hill()['launch'],'a')
  trade(7,'b',threshold);self.assertEqual(self.p.king_of_the_hill()['launch'],'b')
  trade(8,'a',100);self.assertEqual(self.p.king_of_the_hill()['launch'],'b')
  push(9,'b',{'kind':'Graduated','pool':'pool'})
  self.assertEqual(self.p.king_of_the_hill()['launch'],'b')
  self.assertTrue(self.p.coin('a')['kingOfTheHill']['qualified'])
  page=self.p.coins_page(1);self.assertEqual(page['kingOfTheHill']['launch'],'b')
  self.assertEqual(self.p.advance(),0)
  # Independent cursor permits backfill even when the market projection is current.
  self.s.db.execute('DELETE FROM crown_progress');self.s.db.execute("DELETE FROM projection_cursor WHERE name='crown_v1'")
  while self.p.advance(2):pass
  self.assertEqual(self.p.king_of_the_hill()['launch'],'b')
 def test_advanced_crown_uses_actual_allocation_and_fee_burn_progress(self):
  events=[self.event(0,{'kind':'LaunchCreated','mint':'mint','creator':'owner','treasury':'treasury'}),self.event(1,{'kind':'CurveConfigured','sale_tokens':'1000'}),self.event(2,{'kind':'LaunchActivated'}),self.event(3,{'kind':'TradeRecorded','sequence':'1','quote':'1','fee':'0','tokens':'849','buy':True})]
  self.s.ingest('program',10,events,[],finalized=True);self.p.advance();self.assertIsNone(self.p.king_of_the_hill())
  self.s.ingest('program',10,[self.event(4,{'kind':'CoinFeesUsed','mode':'burn','tokens':'1','quote':'1'})],[],finalized=True);self.p.advance()
  self.assertEqual(self.p.king_of_the_hill()['launch'],'launch');self.assertEqual(self.p.coin('launch')['kingOfTheHill']['progressBps'],10000)
 def test_advanced_reserve_projection_accounts_for_sell_fee(self):
  events=[self.event(0,{'kind':'LaunchCreated','mint':'mint','creator':'owner','treasury':'treasury'}),self.event(1,{'kind':'CurveConfigured','sale_tokens':'1000','supply':'2000','virtual_tokens':'2000','virtual_quote':'30'}),self.event(2,{'kind':'LaunchActivated'}),self.event(3,{'kind':'TradeRecorded','sequence':'1','tokens':'100','quote':'100','fee':'5','buy':True}),self.event(4,{'kind':'TradeRecorded','sequence':'2','tokens':'10','quote':'20','fee':'3','buy':False})]
  self.s.ingest('program',10,events,[],finalized=True);self.p.advance()
  state=self.s.db.execute('SELECT sold,quote FROM crown_progress').fetchone();self.assertEqual(tuple(state),(90,77));self.assertEqual(self.p.coin('launch')['progress'],9)

 def test_trade_bump_includes_sells_before_pagination(self):
  def push(slot,index,launch,body):
   e={'program':'program','signature':'sig'+str(slot),'event_index':index,'slot':slot,'body':{'launch':launch,**body}}
   self.s.ingest('program',slot,[e],[],finalized=True);self.p.advance()
  for slot,name in [(10,'old'),(20,'new')]:
   push(slot,0,name,{'kind':'LaunchCreated','mint':'mint'+name,'creator':'owner','treasury':'treasury'})
  push(30,0,'old',{'kind':'TradeRecorded','sequence':'1','quote':'100','fee':'1','buy':True})
  push(40,0,'new',{'kind':'TradeRecorded','sequence':'1','quote':'100','fee':'1','buy':False})
  first=self.p.coins_page(1,sort='bump');self.assertEqual(first['coins'][0]['launch'],'new');self.assertEqual(first['coins'][0]['bumpSlot'],40)
  second=self.p.coins_page(1,first['nextCursor'],sort='bump');self.assertEqual(second['coins'][0]['launch'],'old');self.assertEqual(second['coins'][0]['bumpSlot'],30)
  self.assertEqual(self.p.coins_page(1)['coins'][0]['launch'],'new')
  with self.assertRaises(ValueError):self.p.coins_page(1,first['nextCursor'],sort='new')
  from pump_market import PumpMarket
  PumpMarket(self.s)
  self.s.db.execute("INSERT INTO pump_trades VALUES('pump',0,'pool','new',50,1700000000,'buyer',1,'1','1')")
  self.assertEqual(self.p.coins_page(1,sort='bump')['coins'][0]['launch'],'new')
