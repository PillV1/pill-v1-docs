import unittest
from refusals import blocked_buy,BUY
from events import base58
class RefusalTests(unittest.TestCase):
 def tx(self):return {'slot':1,'transaction':{'signatures':['sig'],'message':{'header':{'numRequiredSignatures':1},'accountKeys':['trader','launch','program'],'instructions':[{'programIdIndex':2,'accounts':[0,1],'data':base58(BUY+(1000).to_bytes(8,'little')+bytes(16))}]}},'meta':{'err':{'InstructionError':[0,{'Custom':6007}]}}}
 def test_blocked_buy_is_explicitly_failed_and_never_fabricates_fees(self):
  events=blocked_buy('program','sig',self.tx());self.assertEqual(len(events),1);self.assertEqual(events[0]['body']['requestedLamports'],'1000');self.assertFalse(events[0]['body']['tradeExecuted']);self.assertNotIn('fee',events[0]['body'])
 def test_success_wrong_program_wrong_error_and_unsigned_trader_do_not_create_refusal(self):
  tx=self.tx();tx['meta']['err']=None;self.assertEqual(blocked_buy('program','sig',tx),[])
  self.assertEqual(blocked_buy('other','sig',self.tx()),[])
  tx=self.tx();tx['meta']['err']['InstructionError'][1]={'Custom':6003};self.assertEqual(blocked_buy('program','sig',tx),[])
  tx=self.tx();tx['transaction']['message']['header']['numRequiredSignatures']=0;self.assertEqual(blocked_buy('program','sig',tx),[])
