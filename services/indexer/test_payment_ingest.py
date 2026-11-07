import tempfile,os,unittest
from unittest.mock import patch
from store import Store
from payments import Payments
from payment_ingest import PaymentIngest
class PollTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.store=Store(os.path.join(self.tmp.name,'db'));self.payments=Payments(self.store)
  for i in ('a','b'):self.payments.create(i,'owner',i,i,100,1000,'h',{},10)
 def tearDown(self):self.store.db.close();self.tmp.cleanup()
 def test_failed_address_does_not_stop_others_and_cursor_only_advances_after_credit(self):
  class Rpc:
   def call(self,method,params):return [{'signature':params[0]+'2','err':None},{'signature':params[0]+'1','err':None}]
  ingester=PaymentIngest(self.store,self.payments,Rpc(),'genesis');credited=[]
  def credit(payments,rpc,signature,genesis):
   self.assertIs(payments,self.payments);self.assertEqual(genesis,'genesis')
   if signature=='a1':raise TimeoutError()
   credited.append(signature)
  with patch('payment_ingest.credit_signature',credit):result=ingester.poll(100)
  self.assertEqual(credited,['b1','b2']);self.assertIn('error',result[0]);rows=dict(self.store.db.execute('SELECT address,signature FROM payment_cursors'));self.assertEqual(rows,{'a':None,'b':'b2'})
 def test_catchup_overflow_never_skips_history(self):
  class Rpc:
   def call(self,method,params):return [{'signature':str(n),'err':None} for n in range(1000)]
  ingester=PaymentIngest(self.store,self.payments,Rpc(),'genesis')
  with patch('payment_ingest.credit_signature') as credit:ingester.poll(100);credit.assert_not_called()
  self.assertEqual(self.store.db.execute('SELECT count(*) FROM payment_cursors WHERE signature IS NOT NULL').fetchone()[0],0)
if __name__=='__main__':unittest.main()
