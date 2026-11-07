import io,json,unittest
from unittest.mock import patch
from ingest import Rpc
class RpcBudgetTests(unittest.TestCase):
 def test_only_genesis_is_cached_and_expiration_revalidates(self):
  calls=[]
  def response(request,timeout):
   body=json.loads(request.data);calls.append(body['method'])
   return io.BytesIO(json.dumps({'result':'mainnet' if body['method']=='getGenesisHash' else 42}).encode())
  with patch('ingest.urllib.request.urlopen',side_effect=response),patch('ingest.time.monotonic',return_value=10):
   rpc=Rpc('https://example.invalid')
   self.assertEqual(rpc.call('getGenesisHash',[]),'mainnet')
   self.assertEqual(rpc.call('getGenesisHash',[]),'mainnet')
   rpc.call('getSlot',[]);rpc.call('getSlot',[])
  with patch('ingest.urllib.request.urlopen',side_effect=response),patch('ingest.time.monotonic',return_value=311):rpc.call('getGenesisHash',[])
  self.assertEqual(calls,['getGenesisHash','getSlot','getSlot','getGenesisHash'])
 def test_failures_are_never_cached(self):
  with patch('ingest.urllib.request.urlopen',side_effect=lambda *a,**k:io.BytesIO(b'{"error":{"code":429}}')),patch('ingest.time.sleep'):
   rpc=Rpc('https://example.invalid')
   with self.assertRaises(RuntimeError):rpc.call('getGenesisHash',[])
   self.assertIsNone(rpc.genesis)
