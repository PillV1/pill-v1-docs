import unittest,tempfile,json
from pathlib import Path
from coin_metadata import CoinMetadata
class MetadataTests(unittest.TestCase):
 def test_first_party_metadata_only_and_safe_images(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/('a'*64+'.json');path.write_text(json.dumps({'description':'hello','image':'https://pillv1.fun/media/'+'b'*64+'.webp','twitter':'https://x.com/test','website':'javascript:alert(1)'}))
   m=CoinMetadata(d);data=m.read('https://pillv1.fun/media/'+path.name)
   self.assertEqual(data['description'],'hello');self.assertTrue(data['image'].startswith('/media/'));self.assertNotIn('website',data)
   for uri in ['https://evil.test/media/'+path.name,'file:///etc/passwd','https://pillv1.fun/media/../../etc/passwd']:
    self.assertEqual(m.read(uri),{})
   self.assertIsNone(m.decorate(None))
