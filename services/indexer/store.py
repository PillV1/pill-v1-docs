"""Single-host finalized-event store and leased work queue. No signing or RPC calls."""
import json, sqlite3, time, uuid
from contextlib import contextmanager
class Store:
 def __init__(self,path):
  self.db=sqlite3.connect(path,timeout=10,isolation_level=None)
  self.db.row_factory=sqlite3.Row
  self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS worker_state(name TEXT PRIMARY KEY,checked_at INTEGER NOT NULL,last_success INTEGER,last_error TEXT,failures INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(signature TEXT NOT NULL, event_index INTEGER NOT NULL, slot INTEGER NOT NULL, program TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(signature,event_index));
CREATE TABLE IF NOT EXISTS transaction_times(signature TEXT PRIMARY KEY,slot INTEGER NOT NULL,time INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS transaction_times_time ON transaction_times(time);
CREATE TABLE IF NOT EXISTS cursors(program TEXT PRIMARY KEY,slot INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,launch TEXT NOT NULL,body TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,signature TEXT,last_error TEXT);
CREATE INDEX IF NOT EXISTS ready_jobs ON jobs(phase,available_at,lease_until);
CREATE UNIQUE INDEX IF NOT EXISTS tx_signature ON jobs(signature) WHERE signature IS NOT NULL;
CREATE TABLE IF NOT EXISTS submissions(job TEXT PRIMARY KEY REFERENCES jobs(id),message_hash TEXT NOT NULL,signature TEXT NOT NULL UNIQUE,wire_transaction TEXT NOT NULL,last_valid_height INTEGER NOT NULL,created_at INTEGER NOT NULL);
''')
 @contextmanager
 def transaction(self):
  self.db.execute('BEGIN IMMEDIATE')
  try:yield;self.db.execute('COMMIT')
  except BaseException:self.db.execute('ROLLBACK');raise
 def ingest(self,program,slot,events,jobs,*,finalized):
  if not finalized:raise ValueError('finality_required')
  if slot<0:raise ValueError('invalid_slot')
  with self.transaction():
   for e in events:
    if e['program']!=program or e['slot']!=slot:raise ValueError('event_identity_mismatch')
    body=json.dumps(e['body'],sort_keys=True,separators=(',',':'))
    old=self.db.execute('SELECT slot,program,body FROM events WHERE signature=? AND event_index=?',(e['signature'],e['event_index'])).fetchone()
    if old and tuple(old)!=(slot,program,body):raise ValueError('conflicting_finalized_event')
    self.db.execute('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?)',(e['signature'],e['event_index'],slot,program,body))
   for j in jobs:
    body=json.dumps(j['body'],sort_keys=True,separators=(',',':'))
    old=self.db.execute('SELECT kind,launch,body FROM jobs WHERE id=?',(j['id'],)).fetchone()
    if old and tuple(old)!=(j['kind'],j['launch'],body):raise ValueError('conflicting_job')
    self.db.execute('INSERT OR IGNORE INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)',(j['id'],j['kind'],j['launch'],body))
   self.db.execute('INSERT INTO cursors VALUES(?,?) ON CONFLICT(program) DO UPDATE SET slot=MAX(cursors.slot,excluded.slot)',(program,slot))
 def record_time(self,signature,slot,stamp):
  if type(slot) is not int or slot<0 or type(stamp) is not int or stamp<0:raise ValueError('invalid_transaction_time')
  old=self.db.execute('SELECT slot,time FROM transaction_times WHERE signature=?',(signature,)).fetchone()
  if old and tuple(old)!=(slot,stamp):raise ValueError('conflicting_transaction_time')
  self.db.execute('INSERT OR IGNORE INTO transaction_times VALUES(?,?,?)',(signature,slot,stamp))
 def acquire(self,now=None,ttl=30):
  now=int(time.time()) if now is None else now
  if not 1<=ttl<=300:raise ValueError('invalid_lease')
  with self.transaction():
   # A prepared/submitted transaction NEVER returns to queued solely because a lease expires.
   row=self.db.execute("SELECT * FROM jobs j WHERE ((phase='queued' AND available_at<=?) OR (phase='working' AND lease_until<?)) AND NOT EXISTS(SELECT 1 FROM jobs busy WHERE busy.launch=j.launch AND busy.id<>j.id AND ((busy.phase='working' AND busy.lease_until>=?) OR busy.phase IN ('prepared','submitted','review'))) ORDER BY available_at,id LIMIT 1",(now,now,now)).fetchone()
   if not row:return None
   lease=str(uuid.uuid4());self.db.execute("UPDATE jobs SET phase='working',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?",(lease,now+ttl,row['id']))
   return dict(self.db.execute('SELECT * FROM jobs WHERE id=?',(row['id'],)).fetchone())
 def prepare(self,job,lease,message_hash,signature,wire_transaction,last_valid_height,now=None):
  now=int(time.time()) if now is None else now
  with self.transaction():
   row=self.db.execute("SELECT * FROM jobs WHERE id=? AND lease=? AND phase='working' AND lease_until>=?",(job,lease,now)).fetchone()
   if not row:raise ValueError('lost_lease')
   self.db.execute('INSERT INTO submissions VALUES(?,?,?,?,?,?)',(job,message_hash,signature,wire_transaction,last_valid_height,now))
   self.db.execute("UPDATE jobs SET phase='prepared',signature=? WHERE id=?",(signature,job))
 def submitted(self,job,signature):
  with self.transaction():
   changed=self.db.execute("UPDATE jobs SET phase='submitted' WHERE id=? AND signature=? AND phase IN ('prepared','submitted')",(job,signature)).rowcount
   if not changed:raise ValueError('submission_mismatch')
 def confirm(self,job,signature,*,finalized,successful):
  if not finalized:raise ValueError('finality_required')
  with self.transaction():
   changed=self.db.execute("UPDATE jobs SET phase=?,lease=NULL,lease_until=0 WHERE id=? AND signature=? AND phase IN ('prepared','submitted','confirmed','review')",('confirmed' if successful else 'review',job,signature)).rowcount
   if not changed:raise ValueError('confirmation_mismatch')
 def retry_unsigned(self,job,lease,error,now=None):
  now=int(time.time()) if now is None else now
  with self.transaction():
   row=self.db.execute("SELECT attempts FROM jobs WHERE id=? AND lease=? AND phase='working' AND lease_until>=?",(job,lease,now)).fetchone()
   if not row:raise ValueError('lost_lease')
   phase='review' if row['attempts']>=8 else 'queued'
   self.db.execute('UPDATE jobs SET phase=?,available_at=?,lease=NULL,lease_until=0,last_error=? WHERE id=?',(phase,now+min(300,2**row['attempts']),error[:200],job))
 def finish_noop(self,job,lease,now=None):
  now=int(time.time()) if now is None else now
  with self.transaction():
   changed=self.db.execute("UPDATE jobs SET phase='noop',lease=NULL,lease_until=0,last_error='maintenance_already_satisfied' WHERE id=? AND lease=? AND phase='working' AND lease_until>=? AND kind LIKE 'keeper_%' AND signature IS NULL",(job,lease,now)).rowcount
   if not changed:raise ValueError('invalid_noop')
 def defer_unsigned(self,job,lease,reason,delay=10,now=None):
  now=int(time.time()) if now is None else now
  if reason not in ('oracle_fulfillment','protection_window') or type(delay) is not int or not 1<=delay<=60:raise ValueError('invalid_deferral')
  with self.transaction():
   changed=self.db.execute("UPDATE jobs SET phase='queued',attempts=MAX(0,attempts-1),available_at=?,lease=NULL,lease_until=0,last_error=? WHERE id=? AND lease=? AND phase='working' AND lease_until>=? AND signature IS NULL",(now+delay,reason,job,lease,now)).rowcount
   if not changed:raise ValueError('lost_lease')
 def heartbeat(self,name,error=None,now=None):
  now=int(time.time()) if now is None else now
  self.db.execute("INSERT INTO worker_state(name,checked_at,last_success,last_error,failures) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET checked_at=excluded.checked_at,last_success=CASE WHEN excluded.last_error IS NULL THEN excluded.checked_at ELSE worker_state.last_success END,last_error=excluded.last_error,failures=CASE WHEN excluded.last_error IS NULL THEN 0 ELSE worker_state.failures+1 END",(name,now,now if error is None else None,error[:100] if error else None,int(error is not None)))
 def health(self,now=None):
  now=int(time.time()) if now is None else now
  return {'workers':[dict(r) for r in self.db.execute('SELECT * FROM worker_state ORDER BY name')],'phases':dict(self.db.execute('SELECT phase,count(*) FROM jobs GROUP BY phase').fetchall()),'expired_leases':self.db.execute("SELECT count(*) FROM jobs WHERE phase='working' AND lease_until<?",(now,)).fetchone()[0],'cursors':dict(self.db.execute('SELECT program,slot FROM cursors').fetchall())}
