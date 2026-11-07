import unittest,tempfile,os,sqlite3,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from backup_backend import backup
class BackupTests(unittest.TestCase):
 def test_wal_backup_is_consistent_private_and_separate(self):
  with tempfile.TemporaryDirectory() as d:
   source=Path(d)/'db';destination=Path(d)/'backup';db=sqlite3.connect(source);db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE t(value TEXT)');db.execute("INSERT INTO t VALUES('committed')");db.commit();db.execute("INSERT INTO t VALUES('uncommitted')")
   backup(source,destination)
   with sqlite3.connect(destination) as restored:self.assertEqual(restored.execute('SELECT * FROM t').fetchall(),[('committed',)])
   self.assertEqual(os.stat(destination).st_mode&0o777,0o600)
   with self.assertRaises(ValueError):backup(source,source)
   db.close()
if __name__=='__main__':unittest.main()
