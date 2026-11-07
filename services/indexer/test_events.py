import base64,hashlib,struct,unittest
from events import transaction_events
P='Fg6PaFpoGXkYsidMpWxTWqkZ7FEfcYkgMQHGhGJvjJF8';OTHER='11111111111111111111111111111111'
def payload():return base64.b64encode(hashlib.sha256(b'event:TreasuryPaid').digest()[:8]+bytes([2])*32+struct.pack('<Q',2**63)).decode()
def tx(logs,err=None):return {'slot':10,'meta':{'err':err,'logMessages':logs}}
class EventTests(unittest.TestCase):
 def test_exact_integer(self):
  e=transaction_events(P,'s',tx([f'Program {P} invoke [1]','Program data: '+payload(),f'Program {P} success']),finalized=True);self.assertEqual(e[0]['body']['amount'],str(2**63))
 def test_nested_program_cannot_spoof(self):
  e=transaction_events(P,'s',tx([f'Program {P} invoke [1]',f'Program {OTHER} invoke [2]','Program data: '+payload(),f'Program {OTHER} success',f'Program {P} success']),finalized=True);self.assertEqual(e,[])
 def test_failed_transaction_has_no_events(self):
  self.assertEqual(transaction_events(P,'s',tx(['Program data: '+payload()],{'InstructionError':[0,'failed']}),finalized=True),[])
 def test_truncated_logs_fail_closed(self):
  with self.assertRaises(ValueError):transaction_events(P,'s',tx([f'Program {P} invoke [1]','Program data: '+payload()]),finalized=True)
 def test_non_finalized_rejected(self):
  with self.assertRaises(ValueError):transaction_events(P,'s',tx([]),finalized=False)
 def test_log_prefix_is_not_program_invocation(self):
  self.assertEqual(transaction_events(P,'s',tx([f'Program log: Program {P} invoke [1]','Program data: '+payload()]),finalized=True),[])
 def test_custody_transfer_event(self):
  raw=hashlib.sha256(b'event:PositionTransferred').digest()[:8]+bytes([2])*32+bytes([3])*32+bytes([4])*32+struct.pack('<QQ',2**63,7)
  logs=[f'Program {P} invoke [1]','Program data: '+base64.b64encode(raw).decode(),f'Program {P} success']
  body=transaction_events(P,'s',tx(logs),finalized=True)[0]['body']
  self.assertEqual(body['kind'],'PositionTransferred');self.assertEqual(body['amount'],str(2**63));self.assertEqual(body['sequence'],'7');self.assertNotEqual(body['sender'],body['recipient'])
 def test_developer_unlock_timestamp_is_signed_integer(self):
  raw=hashlib.sha256(b'event:DeveloperAllocated').digest()[:8]+bytes([2])*32+bytes([3])*32+struct.pack('<Qq',100,86400)
  body=transaction_events(P,'s',tx([f'Program {P} invoke [1]','Program data: '+base64.b64encode(raw).decode(),f'Program {P} success']),finalized=True)[0]['body']
  self.assertEqual(body['tokens'],'100');self.assertEqual(body['unlock_at'],'86400')
 def test_metadata_strings_are_exact_and_bounded(self):
  from events import decode
  prefix=hashlib.sha256(b'event:TokenMetadataPublished').digest()[:8]+bytes([2])*32
  strings=['Coin','TEST','ipfs://metadata'];raw=prefix+b''.join(struct.pack('<I',len(s.encode()))+s.encode() for s in strings)
  self.assertEqual(decode(raw)['uri'],strings[2])
  for data in [prefix+struct.pack('<I',33)+b'a'*33,raw[:-1],raw+b'x',prefix+struct.pack('<I',1)+b'\xff']:
   with self.assertRaises(ValueError):decode(data)
 def test_curve_configuration_preserves_exact_sale_allocation(self):
  from events import decode
  raw=hashlib.sha256(b'event:CurveConfigured').digest()[:8]+bytes([2])*32+struct.pack('<QQQQ',800000000000000,1000000000000000,1073000000000000,30000000000)
  self.assertEqual(decode(raw)['sale_tokens'],'800000000000000')
  with self.assertRaises(ValueError):decode(raw[:-1])

class GraduationCostTests(unittest.TestCase):
 def test_exact_costs_and_failed_migration_event_rejection(self):
  from events import decode
  raw=hashlib.sha256(b'event:GraduationCosts').digest()[:8]+bytes([2])*32+struct.pack('<QQ',12345678,50000000)
  body=decode(raw);self.assertEqual(body['setup_lamports'],'12345678');self.assertEqual(body['max_setup_lamports'],'50000000')
  with self.assertRaises(ValueError):decode(raw[:-1])
  logs=[f'Program {P} invoke [1]','Program data: '+base64.b64encode(raw).decode(),f'Program {P} success']
  self.assertEqual(transaction_events(P,'s',tx(logs,{'InstructionError':[0,'failed']}),finalized=True),[])
