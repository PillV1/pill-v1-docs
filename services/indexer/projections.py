"""Replayable read models from finalized events. Amounts stay decimal strings externally."""
import json,base64,binascii

def encode_cursor(kind,values):
 return base64.urlsafe_b64encode(json.dumps([1,kind,*values],separators=(',',':')).encode()).decode().rstrip('=')

def decode_cursor(value,kind,types):
 if not isinstance(value,str) or not value or len(value)>512:raise ValueError('invalid_cursor')
 try:
  data=json.loads(base64.b64decode(value+'='*((-len(value))%4),altchars=b'-_',validate=True))
 except (ValueError,binascii.Error,UnicodeError):raise ValueError('invalid_cursor') from None
 if not isinstance(data,list) or data[:2]!=[1,kind] or len(data)!=len(types)+2:raise ValueError('invalid_cursor')
 if any(type(v) is not t for v,t in zip(data[2:],types)):raise ValueError('invalid_cursor')
 if any(v<0 or v>9223372036854775807 for v in data[2:] if type(v) is int):raise ValueError('invalid_cursor')
 return data[2:]
class Projections:
 def __init__(self,store):
  self.store=store;self.db=store.db
  self.db.executescript('''
CREATE TABLE IF NOT EXISTS projection_cursor(name TEXT PRIMARY KEY,event_row INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS crown_progress(launch TEXT PRIMARY KEY,sale_tokens INTEGER,sold INTEGER NOT NULL DEFAULT 0,crowned_slot INTEGER,crowned_row INTEGER);
CREATE TABLE IF NOT EXISTS coins(launch TEXT PRIMARY KEY,mint TEXT NOT NULL UNIQUE,creator TEXT NOT NULL,treasury TEXT NOT NULL,pool TEXT,phase TEXT NOT NULL DEFAULT 'curve',last_sequence INTEGER NOT NULL DEFAULT 0,created_slot INTEGER NOT NULL,last_slot INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coin_activity(signature TEXT NOT NULL,event_index INTEGER NOT NULL,launch TEXT NOT NULL,slot INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(signature,event_index));
CREATE INDEX IF NOT EXISTS activity_launch ON coin_activity(launch,slot,event_index);
CREATE INDEX IF NOT EXISTS activity_trade_bump ON coin_activity(launch,slot DESC) WHERE kind='TradeRecorded';
CREATE INDEX IF NOT EXISTS activity_buy_bump ON coin_activity(launch,slot DESC) WHERE kind='TradeRecorded' AND json_extract(body,'$.buy')=1;
CREATE INDEX IF NOT EXISTS coins_page ON coins(created_slot DESC,launch);
CREATE INDEX IF NOT EXISTS activity_page ON coin_activity(launch,slot DESC,signature,event_index);
''')
  crown_columns={row[1] for row in self.db.execute('PRAGMA table_info(crown_progress)')}
  additions=[name for name in ('quote','supply','virtual_tokens','virtual_quote') if name not in crown_columns]
  for name in additions:self.db.execute('ALTER TABLE crown_progress ADD COLUMN '+name+' INTEGER NOT NULL DEFAULT 0')
  if additions:
   self.db.execute('DELETE FROM crown_progress');self.db.execute("DELETE FROM projection_cursor WHERE name='crown_v1'")
  columns={row[1] for row in self.db.execute('PRAGMA table_info(coins)')}
  for name in ('name','symbol','uri'):
   if name not in columns:self.db.execute('ALTER TABLE coins ADD COLUMN '+name+' TEXT')
  if 'version' not in columns:self.db.execute('ALTER TABLE coins ADD COLUMN version INTEGER NOT NULL DEFAULT 11')
  if 'metadata_slot' not in columns:self.db.execute('ALTER TABLE coins ADD COLUMN metadata_slot INTEGER NOT NULL DEFAULT 0')
 def advance(self,limit=1000):
  if not 1<=limit<=10000:raise ValueError('invalid_limit')
  with self.store.transaction():
   cursor=self.db.execute("SELECT event_row FROM projection_cursor WHERE name='market'").fetchone();start=cursor[0] if cursor else 0
   rows=self.db.execute('SELECT rowid,* FROM events WHERE rowid>? ORDER BY rowid LIMIT ?',(start,limit)).fetchall()
   for row in rows:
    body=json.loads(row['body']);kind=body.get('kind');launch=body.get('launch')
    if not launch:continue
    if kind=='LaunchCreated':
     existing=self.db.execute('SELECT mint,creator,treasury FROM coins WHERE launch=?',(launch,)).fetchone()
     facts=(body['mint'],body['creator'],body['treasury'])
     if existing and tuple(existing)!=facts:raise ValueError('conflicting_launch')
     self.db.execute('INSERT OR IGNORE INTO coins(launch,mint,creator,treasury,created_slot,last_slot) VALUES(?,?,?,?,?,?)',(launch,*facts,row['slot'],row['slot']))
     self.db.execute("UPDATE coins SET phase='pending' WHERE launch=? AND phase='curve' AND last_sequence=0",(launch,))
    elif kind=='LaunchVersionSelected':
     if body['version'] not in (1,11):raise ValueError('invalid_launch_version')
     self.db.execute("UPDATE coins SET version=?,phase=CASE WHEN ?=1 AND phase='pending' THEN 'curve' ELSE phase END WHERE launch=? AND mint=?",(body['version'],body['version'],launch,body['mint']))
    elif kind=='LaunchCancelled':
     self.db.execute("UPDATE coins SET phase='cancelled' WHERE launch=?",(launch,))
    elif kind=='LaunchActivated':
     self.db.execute("UPDATE coins SET phase='curve',last_slot=MAX(last_slot,?) WHERE launch=? AND phase='pending'",(row['slot'],launch))
    elif kind=='TokenMetadataPublished':
     self.db.execute('UPDATE coins SET name=?,symbol=?,uri=?,metadata_slot=? WHERE launch=? AND metadata_slot<=?',(body['name'],body['symbol'],body['uri'],row['slot'],launch,row['slot']))
    elif kind=='Graduated':
     self.db.execute("UPDATE coins SET phase='pumpswap',pool=?,last_slot=MAX(last_slot,?) WHERE launch=?",(body['pool'],row['slot'],launch))
    elif kind in ('TradeRecorded','PositionTransferred'):
     sequence=int(body['sequence'])
     self.db.execute('UPDATE coins SET last_sequence=MAX(last_sequence,?),last_slot=MAX(last_slot,?) WHERE launch=?',(sequence,row['slot'],launch))
    self.db.execute('INSERT OR IGNORE INTO coin_activity VALUES(?,?,?,?,?,?)',(row['signature'],row['event_index'],launch,row['slot'],kind,row['body']))
   if rows:self.db.execute("INSERT INTO projection_cursor VALUES('market',?) ON CONFLICT(name) DO UPDATE SET event_row=excluded.event_row",(rows[-1]['rowid'],))
   crown_count=self._advance_crown(limit)
   return max(len(rows),crown_count)
 def _advance_crown(self,limit):
  cursor=self.db.execute("SELECT event_row FROM projection_cursor WHERE name='crown_v1'").fetchone()
  rows=self.db.execute('SELECT rowid,* FROM events WHERE rowid>? ORDER BY rowid LIMIT ?',(cursor[0] if cursor else 0,limit)).fetchall()
  for row in rows:
   b=json.loads(row['body']);launch=b.get('launch');kind=b.get('kind')
   if not launch:continue
   self.db.execute('INSERT OR IGNORE INTO crown_progress(launch) VALUES(?)',(launch,))
   if kind=='CurveConfigured':
    sale=int(b['sale_tokens'])
    if sale<=0:raise ValueError('invalid_sale_allocation')
    self.db.execute('UPDATE crown_progress SET sale_tokens=?,supply=?,virtual_tokens=?,virtual_quote=? WHERE launch=?',(sale,int(b.get('supply',0)),int(b.get('virtual_tokens',0)),int(b.get('virtual_quote',0)),launch))
   elif kind=='LaunchVersionSelected' and b['version']==1:
    self.db.execute('UPDATE crown_progress SET sale_tokens=793100000000000,supply=1000000000000000,virtual_tokens=1073000000000000,virtual_quote=30000000000 WHERE launch=?',(launch,))
   delta=0
   if kind=='TradeRecorded' and 'tokens' in b and 'buy' in b:delta=int(b['tokens'])*(1 if b['buy'] else -1)
   elif kind=='CoinFeesUsed' and b['mode']=='burn':delta=int(b['tokens'])
   if delta:
    quote=int(b['quote'])
    coin=self.db.execute('SELECT version FROM coins WHERE launch=?',(launch,)).fetchone()
    if kind=='TradeRecorded' and not b['buy'] and coin and coin['version']==11:quote+=int(b['fee'])
    self.db.execute('UPDATE crown_progress SET sold=sold+?,quote=quote+? WHERE launch=?',(delta,quote*(1 if delta>0 else -1),launch))
   progress=self.db.execute('SELECT * FROM crown_progress WHERE launch=?',(launch,)).fetchone()
   # Integer cross-multiplication avoids rounding a just-below-threshold coin up.
   if progress['sale_tokens'] and progress['sold']*100>=progress['sale_tokens']*85 and progress['crowned_row'] is None:
    self.db.execute('UPDATE crown_progress SET crowned_slot=?,crowned_row=? WHERE launch=?',(row['slot'],row['rowid'],launch))
  if rows:self.db.execute("INSERT INTO projection_cursor VALUES('crown_v1',?) ON CONFLICT(name) DO UPDATE SET event_row=excluded.event_row",(rows[-1]['rowid'],))
  return len(rows)
 def king_of_the_hill(self):
  row=self.db.execute("SELECT c.*,p.crowned_slot AS crownedSlot FROM crown_progress p JOIN coins c ON c.launch=p.launch WHERE p.crowned_row IS NOT NULL AND c.phase IN ('curve','pumpswap') ORDER BY p.crowned_slot DESC,p.crowned_row DESC LIMIT 1").fetchone()
  return self._with_crown(dict(row)) if row else None
 def _with_crown(self,coin):
  p=self.db.execute('SELECT p.*,t.time FROM crown_progress p LEFT JOIN events e ON e.rowid=p.crowned_row LEFT JOIN transaction_times t ON t.signature=e.signature WHERE p.launch=?',(coin['launch'],)).fetchone()
  coin['kingOfTheHill']={'qualified':bool(p and p['crowned_row'] is not None),'crownedSlot':p['crowned_slot'] if p else None,'crownedAt':p['time'] if p else None,'progressBps':min(10000,max(0,p['sold']*1000000//(p['sale_tokens']*85))) if p and p['sale_tokens'] else None}
  if coin['version']==2 and coin['kingOfTheHill']['qualified']:
   native=self.db.execute('SELECT crowned_at FROM native_pump WHERE mint=?',(coin['mint'],)).fetchone()
   coin['kingOfTheHill']['crownedAt']=native[0] if native else None
  if p and p['sale_tokens']:
   coin['progress']=min(10000,max(0,p['sold']*10000//p['sale_tokens']))/100
   if coin['phase']=='curve' and p['virtual_tokens']>p['sold'] and p['supply']>0:
    from decimal import Decimal
    cap=(p['virtual_quote']+p['quote'])*p['supply']//(p['virtual_tokens']-p['sold'])
    coin['cap']=str(Decimal(cap)/Decimal(1000000000))
  if p and p['supply']>0 and coin['phase']=='pumpswap' and self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pump_trades'").fetchone():
   last=self.db.execute('SELECT base,quote FROM pump_trades WHERE launch=? ORDER BY slot DESC,rowid DESC LIMIT 1',(coin['launch'],)).fetchone()
   if last and int(last['base'])>0:
    from decimal import Decimal
    coin['cap']=str(Decimal(last['quote'])*Decimal(p['supply'])/Decimal(last['base'])/Decimal(1000000000))
  coin['bumpSlot']=self.db.execute('SELECT '+self._bump_sql()+' FROM coins c WHERE c.launch=?',(coin['launch'],)).fetchone()[0]
  coin['lastTradeSlot']=self.db.execute("SELECT MAX(slot) FROM coin_activity WHERE launch=? AND kind='TradeRecorded'",(coin['launch'],)).fetchone()[0]
  stamp=self.db.execute("SELECT t.time FROM coin_activity a JOIN transaction_times t ON t.signature=a.signature WHERE a.launch=? AND a.kind='LaunchCreated' LIMIT 1",(coin['launch'],)).fetchone()
  coin['createdAt']=stamp[0] if stamp else None
  if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discussions'").fetchone():coin['replyCount']=self.db.execute('SELECT COUNT(*) FROM discussions WHERE mint=? AND hidden=0',(coin['mint'],)).fetchone()[0]
  else:coin['replyCount']=0
  return coin
 def coins(self,limit=50,before_slot=None):
  if not 1<=limit<=100:raise ValueError('invalid_limit')
  if before_slot is None:return [dict(x) for x in self.db.execute('SELECT * FROM coins ORDER BY created_slot DESC,launch LIMIT ?',(limit,))]
  return [dict(x) for x in self.db.execute('SELECT * FROM coins WHERE created_slot<? ORDER BY created_slot DESC,launch LIMIT ?',(before_slot,limit))]
 def activity(self,launch,limit=50):
  if not 1<=limit<=100:raise ValueError('invalid_limit')
  return [dict(x)|{'body':json.loads(x['body'])} for x in self.db.execute('SELECT * FROM coin_activity WHERE launch=? ORDER BY slot DESC,event_index DESC LIMIT ?',(launch,limit))]
 def coin(self,launch):
  row=self.db.execute('SELECT * FROM coins WHERE launch=?',(launch,)).fetchone()
  return self._with_crown(dict(row)) if row else None
 def _bump_sql(self):
  curve="COALESCE((SELECT MAX(a.slot) FROM coin_activity a WHERE a.launch=c.launch AND a.kind='TradeRecorded'),0)"
  pump="COALESCE((SELECT MAX(p.slot) FROM pump_trades p WHERE p.launch=c.launch),0)" if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pump_trades'").fetchone() else '0'
  return 'MAX(c.created_slot,'+curve+','+pump+')'
 def coins_page(self,limit=50,cursor=None,phase=None,sort="new"):
  if type(limit) is not int or not 1<=limit<=100:raise ValueError('invalid_limit')
  if phase not in (None,'pending','curve','pumpswap','cancelled'):raise ValueError('invalid_phase')
  if sort not in ('new','bump'):raise ValueError('invalid_sort')
  ordering='created_slot' if sort=='new' else 'bumpSlot'
  cursor_kind='coins' if sort=='new' else 'coins_bump'
  where=[] if phase=='cancelled' else ["phase!='cancelled'"];values=[]
  if phase:where.append('phase=?');values.append(phase)
  if cursor:
   slot,launch,previous_phase=decode_cursor(cursor,cursor_kind,[int,str,str])
   if previous_phase!=(phase or ''):raise ValueError('cursor_filter_mismatch')
   where.append('('+ordering+'<? OR ('+ordering+'=? AND launch>?))');values.extend([slot,slot,launch])
  source='coins' if sort=='new' else '(SELECT c.*,'+self._bump_sql()+' AS bumpSlot FROM coins c)'
  sql='SELECT * FROM '+source+(' WHERE '+' AND '.join(where) if where else '')+' ORDER BY '+ordering+' DESC,launch LIMIT ?'
  rows=[dict(row) for row in self.db.execute(sql,(*values,limit+1))];more=len(rows)>limit;rows=rows[:limit]
  next_cursor=encode_cursor(cursor_kind,[rows[-1][ordering],rows[-1]['launch'],phase or '']) if more else None
  return {'coins':[self._with_crown(row) for row in rows],'nextCursor':next_cursor,'kingOfTheHill':self.king_of_the_hill(),'kingOfTheHillRule':{'saleAllocationBps':8500}}
 def activity_page(self,launch,limit=50,cursor=None):
  if type(limit) is not int or not 1<=limit<=100:raise ValueError('invalid_limit')
  where='launch=?';values=[launch]
  if cursor:
   slot,signature,event_index,previous_launch=decode_cursor(cursor,'activity',[int,str,int,str])
   if previous_launch!=launch:raise ValueError('cursor_filter_mismatch')
   where+=' AND (slot<? OR (slot=? AND (signature>? OR (signature=? AND event_index>?))))'
   values.extend([slot,slot,signature,signature,event_index])
  rows=[dict(row)|{'body':json.loads(row['body'])} for row in self.db.execute('SELECT * FROM coin_activity WHERE '+where+' ORDER BY slot DESC,signature,event_index LIMIT ?',(*values,limit+1))]
  more=len(rows)>limit;rows=rows[:limit]
  next_cursor=encode_cursor('activity',[rows[-1]['slot'],rows[-1]['signature'],rows[-1]['event_index'],launch]) if more else None
  return {'activity':rows,'nextCursor':next_cursor}
 def stats(self):
  counts=dict(self.db.execute('SELECT phase,COUNT(*) FROM coins GROUP BY phase').fetchall());volume=fees=burned=rewards=0
  for row in self.db.execute("SELECT body FROM coin_activity WHERE kind IN ('TradeRecorded','CoinFeesUsed','PoolFeesSettled')"):
   b=json.loads(row[0])
   if b['kind']=='TradeRecorded':volume+=int(b['quote']);fees+=int(b['fee'])
   elif b['kind']=='PoolFeesSettled':burned+=int(b['burned'])
   elif b['mode']=='burn':burned+=int(b['tokens'])
   elif b['mode']=='holders':rewards+=int(b['quote'])
  return {'coins':sum(counts.values()),'phases':counts,'curveVolumeLamports':str(volume),'curveFeesLamports':str(fees),'tokensBurnedRaw':str(burned),'holderRewardsLamports':str(rewards),'scope':'indexed_program_events_only'}
