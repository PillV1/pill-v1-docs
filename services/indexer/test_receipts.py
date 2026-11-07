import copy,unittest
from receipts import verify_sol_receipts,SYSTEM
SIG='1'*64;DEST='So11111111111111111111111111111111111111112'
def instruction(program=SYSTEM,amount=100):return {'programId':program,'parsed':{'type':'transfer','info':{'source':SYSTEM,'destination':DEST,'lamports':amount}}}
class Rpc:
 def __init__(self):
  self.genesis='test-chain';self.status={'slot':5,'confirmationStatus':'finalized','err':None}
  self.tx={'slot':5,'blockTime':100,'transaction':{'signatures':[SIG],'message':{'instructions':[instruction()]}},'meta':{'err':None,'innerInstructions':[]}}
 def call(self,method,params):
  if method=='getGenesisHash':return self.genesis
  if method=='getSignatureStatuses':return {'value':[self.status]}
  if method=='getTransaction':
   assert params[1]['commitment']=='finalized';return self.tx
  raise AssertionError(method)
class ReceiptTests(unittest.TestCase):
 def test_real_program_identity_and_exact_amount(self):
  rpc=Rpc();r=verify_sol_receipts(rpc,SIG,'test-chain');self.assertEqual(r[0]['amount'],100);self.assertTrue(r[0]['finalized'])
 def test_spoofed_program_ignored(self):
  rpc=Rpc();rpc.tx['transaction']['message']['instructions']=[instruction(DEST)];self.assertEqual(verify_sol_receipts(rpc,SIG,'test-chain'),[])
 def test_wrong_chain_rejected(self):
  with self.assertRaises(ValueError):verify_sol_receipts(Rpc(),SIG,'other-chain')
 def test_unfinalized_or_failed_never_credits(self):
  rpc=Rpc();rpc.status['confirmationStatus']='confirmed'
  with self.assertRaises(ValueError):verify_sol_receipts(rpc,SIG,'test-chain')
  rpc.status['confirmationStatus']='finalized';rpc.status['err']={'error':'failed'};self.assertEqual(verify_sol_receipts(rpc,SIG,'test-chain'),[])
 def test_inner_transfers_have_distinct_receipt_ids(self):
  rpc=Rpc();rpc.tx['meta']['innerInstructions']=[{'index':0,'instructions':[instruction(),instruction()]}]
  self.assertEqual([x['instruction_index'] for x in verify_sol_receipts(rpc,SIG,'test-chain')],[0,1,2])
 def test_mismatched_signature_or_slot_rejected(self):
  for field,value in [('slot',6),('blockTime',None)]:
   rpc=Rpc();rpc.tx[field]=value
   with self.assertRaises(ValueError):verify_sol_receipts(rpc,SIG,'test-chain')
  rpc=Rpc();rpc.tx['transaction']['signatures']=['other']
  with self.assertRaises(ValueError):verify_sol_receipts(rpc,SIG,'test-chain')
 def test_float_bool_and_zero_amounts_rejected(self):
  for amount in [1.5,True,0,-1]:
   rpc=Rpc();rpc.tx['transaction']['message']['instructions']=[instruction(amount=amount)]
   with self.assertRaises(ValueError):verify_sol_receipts(rpc,SIG,'test-chain')
 def test_duplicate_inner_group_rejected(self):
  rpc=Rpc();group={'index':0,'instructions':[instruction()]};rpc.tx['meta']['innerInstructions']=[group,group]
  with self.assertRaises(ValueError):verify_sol_receipts(rpc,SIG,'test-chain')
