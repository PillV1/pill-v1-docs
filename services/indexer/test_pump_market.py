import unittest,tempfile,os,base64
from store import Store
from projections import Projections
from pump_market import PumpMarket,PROGRAM,FIELDS,TAGS,EVENT_CPI,trades,decode
from events import base58
POOL=base58(bytes([3])*32);USER=base58(bytes([4])*32)
def event(base=1000000,quote=1000000000,stamp=1000):
 tag=next(k for k,v in TAGS.items() if v=='BuyEvent');parts=[tag]
 for field in FIELDS['BuyEvent']:
  name,typ=field['name'],field['type'];value={'base_amount_out':base,'quote_amount_in':quote,'timestamp':stamp}.get(name,0)
  if typ=='pubkey':data=bytes([3 if name=='pool' else 4])*32
  elif typ=='string':data=(3).to_bytes(4,'little')+b'buy'
  elif typ=='bool':data=b'\0'
  else:data=value.to_bytes(16 if typ=='i128' else 8,'little',signed=typ.startswith('i'))
  parts.append(data)
 return b''.join(parts)
def transaction(data,signature='sig',program=PROGRAM):return {'slot':10,'transaction':{'signatures':[signature],'message':{'accountKeys':[program]}},'meta':{'err':None,'innerInstructions':[{'index':0,'instructions':[{'programIdIndex':0,'data':base58(EVENT_CPI+data)}]}],'logMessages':[]}}
class MarketTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.store=Store(os.path.join(self.tmp.name,'db'));Projections(self.store);self.market=PumpMarket(self.store)
  self.store.db.execute("INSERT INTO coins(launch,mint,creator,treasury,pool,phase,created_slot,last_slot) VALUES('launch','mint','creator','treasury',?,'pumpswap',1,1)",(POOL,))
 def tearDown(self):self.store.db.close();self.tmp.cleanup()
 def test_only_fixed_program_events_and_known_pool_are_projected(self):
  self.assertEqual(trades(transaction(event(),program='other')),[])
  self.market.record('sig',transaction(event()),finalized=True);self.market.record('sig',transaction(event()),finalized=True)
  self.assertEqual(self.store.db.execute('SELECT count(*) FROM pump_trades').fetchone()[0],1)
  with self.assertRaises(ValueError):self.market.record('sig',transaction(event(quote=2)),finalized=True)
  with self.assertRaises(ValueError):self.market.record('sig',transaction(event()),finalized=False)
 def test_exact_candles_do_not_double_count_replay_or_use_float_amounts(self):
  self.market.record('a',transaction(event(quote=1000000000),'a'),finalized=True)
  self.market.record('b',transaction(event(quote=2000000000),'b'),finalized=True)
  self.market.record('c',transaction(event(quote=500000000),'c'),finalized=True)
  bar=self.market.candles('launch')['candles'][0];self.assertEqual(bar['open'],'1');self.assertEqual(bar['high'],'2');self.assertEqual(bar['low'],'0.5');self.assertEqual(bar['close'],'0.5');self.assertEqual(bar['volumeLamports'],'3500000000');self.assertEqual(bar['trades'],3)
  with self.assertRaises(ValueError):self.market.candles('launch',interval=7)
 def test_truncation_unknown_versions_and_log_spoofing_are_rejected(self):
  with self.assertRaises(ValueError):decode(event()[:-1])
  with self.assertRaises(ValueError):decode(event()+b'\0')
  tx=transaction(event());tx['meta']['innerInstructions']=[];tx['meta']['logMessages']=['Program other invoke [1]','Program data: '+base64.b64encode(event()).decode(),'Program other success'];self.assertEqual(trades(tx),[])
  tx['meta']['logMessages']=[f'Program {PROGRAM} invoke [1]','Program data: '+base64.b64encode(event()).decode(),f'Program {PROGRAM} success'];self.assertEqual(len(trades(tx)),1)
 def test_market_summary_bounds_the_window_and_labels_execution_price(self):
  for sig,stamp,quote in [('old',1,1000000000),('a',99900,2000000000),('b',99999,3000000000)]:self.market.record(sig,transaction(event(quote=quote,stamp=stamp),sig),finalized=True)
  summary=self.market.summary('launch',100000)
  self.assertEqual(summary['buys24h'],2);self.assertEqual(summary['buyers24h'],1);self.assertEqual(summary['volumeLamports24h'],'5000000000');self.assertEqual(summary['lastExecutionPriceSol'],'3')
  self.assertIsNone(self.market.summary('empty',100000)['lastExecutionPriceSol'])
 def test_network_mismatch_prevents_polling(self):
  class Rpc:
   def call(self,*args):return 'wrong'
  with self.assertRaises(ValueError):self.market.poll(Rpc(),'expected',100)
if __name__=='__main__':unittest.main()
