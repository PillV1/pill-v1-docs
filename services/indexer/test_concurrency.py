import unittest,tempfile,os
from concurrent.futures import ThreadPoolExecutor
from store import Store
class ConcurrencyTests(unittest.TestCase):
 def test_eight_workers_claim_each_of_300_jobs_exactly_once(self):
  with tempfile.TemporaryDirectory() as d:
   path=os.path.join(d,'db');s=Store(path);s.ingest('p',1,[],[{'id':str(i).zfill(5),'kind':'test','launch':'coin'+str(i),'body':{}} for i in range(300)],finalized=True);s.db.close()
   def run(_):
    local=Store(path);claimed=[]
    try:
     while True:
      job=local.acquire(now=100)
      if not job:break
      local.prepare(job['id'],job['lease'],'hash','sig'+job['id'],'testbytes',1000,now=100);local.confirm(job['id'],'sig'+job['id'],finalized=True,successful=True);claimed.append(job['id'])
    finally:local.db.close()
    return claimed
   with ThreadPoolExecutor(max_workers=8) as pool:claimed=[j for result in pool.map(run,range(8)) for j in result]
   self.assertEqual(len(claimed),300);self.assertEqual(len(set(claimed)),300)
if __name__=='__main__':unittest.main()
