"""Read immutable first-party upload metadata without fetching arbitrary URLs."""
import json,re
from pathlib import Path
from functools import lru_cache
from urllib.parse import urlsplit
class CoinMetadata:
 def __init__(self,directory,origin='https://pillv1.fun'):
  self.directory=Path(directory);self.origin=urlsplit(origin).netloc
 @lru_cache(maxsize=256)
 def read(self,uri):
  try:
   u=urlsplit(uri or '')
   if u.scheme!='https' or u.netloc!=self.origin or not re.fullmatch(r'/media/[a-f0-9]{64}\.json',u.path):return {}
   file=self.directory/u.path.rsplit('/',1)[-1]
   if file.stat().st_size>16384:return {}
   data=json.loads(file.read_text());out={}
   if isinstance(data.get('description'),str):out['description']=data['description'][:2000]
   image=urlsplit(data.get('image',''))
   if image.scheme=='https' and image.netloc==self.origin and re.fullmatch(r'/media/[a-f0-9]{64}\.webp',image.path):out['image']=image.path
   for field in ('twitter','telegram','website'):
    raw=data.get(field)
    if not isinstance(raw,str) or len(raw)>500:continue
    link=urlsplit(raw)
    if link.scheme=='https' and link.netloc and not link.username and not link.password:out[field]=raw
   return out
  except (ValueError,TypeError,OSError):return {}
 def decorate(self,coin):return {**coin,**self.read(coin.get('uri'))} if coin else None
