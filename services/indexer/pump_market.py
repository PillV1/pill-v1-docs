"""Finalized PumpSwap trade decoding and market read model for our known pools only."""
import base64,json,struct
from decimal import Decimal,localcontext
from pathlib import Path
from events import base58,INVOKE,END
PROGRAM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
CURRENT_IDL=json.loads((Path(__file__).resolve().parents[2]/'vendor/pump_amm_holder_rewards.json').read_text())
OLD_IDL=json.loads((Path(__file__).resolve().parents[2]/'vendor/pump_amm.json').read_text())
IDL=json.loads((Path(__file__).resolve().parents[2]/'vendor/pump_amm_v2.json').read_text())
TAGS={bytes(e['discriminator']):e['name'] for e in IDL['events'] if e['name'] in ('BuyEvent','SellEvent')}
FIELDS={t['name']:t['type']['fields'] for t in IDL['types'] if t['name'] in TAGS.values()}
CURRENT_FIELDS={t['name']:t['type']['fields'] for t in CURRENT_IDL['types'] if t['name'] in TAGS.values()}
OLD_FIELDS={t['name']:t['type']['fields'] for t in OLD_IDL['types'] if t['name'] in TAGS.values()}
EVENT_CPI=bytes([228,69,165,46,81,203,154,29])
def unbase58(value):
 alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';n=0
 if not isinstance(value,str) or len(value)>8192:raise ValueError('invalid_instruction_data')
 for char in value:n=n*58+alphabet.index(char)
 return b'\0'*(len(value)-len(value.lstrip('1')))+(n.to_bytes((n.bit_length()+7)//8,'big') if n else b'')
def _decode(data,fields):
 name=TAGS.get(data[:8])
 if name is None:return None
 offset=8;out={'kind':name}
 for field in fields[name]:
  typ=field['type'];size={'u64':8,'i64':8,'i128':16,'bool':1,'pubkey':32}.get(typ)
  if typ=='string':
   if len(data)<offset+4:raise ValueError('truncated_market_event')
   size=int.from_bytes(data[offset:offset+4],'little');offset+=4
   if size>100:raise ValueError('oversized_market_string')
  if size is None or len(data)<offset+size:raise ValueError('truncated_market_event')
  value=data[offset:offset+size];offset+=size
  if typ=='pubkey':value=base58(value)
  elif typ=='string':value=value.decode('utf8',errors='strict')
  elif typ=='bool':
   if value[0]>1:raise ValueError('invalid_market_bool')
   value=bool(value[0])
  else:value=int.from_bytes(value,'little',signed=typ.startswith('i'))
  out[field['name']]=value
 if offset!=len(data):raise ValueError('unsupported_market_event_version')
 return out

def decode(data):
 # Strictly recognize all pinned schemas, including current holder-reward pools.
 error=None
 for schema in (CURRENT_FIELDS,FIELDS,OLD_FIELDS):
  try:return _decode(data,schema)
  except ValueError as failure:error=failure
 raise error

def trades(transaction):
 meta=transaction.get('meta')
 if not meta or meta.get('err') is not None:return []
 keys=transaction['transaction']['message']['accountKeys'];keys=[k if isinstance(k,str) else k['pubkey'] for k in keys]
 loaded=meta.get('loadedAddresses') or {};keys+=loaded.get('writable',[])+loaded.get('readonly',[])
 result=[]
 for group in meta.get('innerInstructions') or []:
  for instruction in group['instructions']:
   index=instruction.get('programIdIndex')
   if type(index) is not int or not 0<=index<len(keys) or keys[index]!=PROGRAM:continue
   data=unbase58(instruction['data'])
   if data[:8]==EVENT_CPI:
    event=decode(data[8:])
    if event:result.append(event)
 if result:return result # Anchor CPI events take precedence over duplicate log rendering.
 stack=[]
 for line in meta.get('logMessages') or []:
  invoke=INVOKE.fullmatch(line);end=END.fullmatch(line)
  if invoke:
   if int(invoke[2])!=len(stack)+1:raise ValueError('invalid_invocation_stack')
   stack.append(invoke[1])
  elif end:
   if not stack or stack.pop()!=end[1]:raise ValueError('invalid_invocation_stack')
  elif line.startswith('Program data: ') and stack and stack[-1]==PROGRAM:
   event=decode(base64.b64decode(line[14:],validate=True))
   if event:result.append(event)
 if stack:raise ValueError('incomplete_invocation_stack')
 return result

class PumpMarket:
 def __init__(self,store):
  self.store=store;self.db=store.db
  self.db.executescript('''CREATE TABLE IF NOT EXISTS pump_trades(signature TEXT NOT NULL,event_index INTEGER NOT NULL,pool TEXT NOT NULL,launch TEXT NOT NULL,slot INTEGER NOT NULL,time INTEGER NOT NULL,trader TEXT NOT NULL,buy INTEGER NOT NULL,base TEXT NOT NULL,quote TEXT NOT NULL,PRIMARY KEY(signature,event_index));
CREATE INDEX IF NOT EXISTS pump_market_page ON pump_trades(launch,time,slot);
CREATE TABLE IF NOT EXISTS pump_cursors(pool TEXT PRIMARY KEY,signature TEXT,last_polled INTEGER NOT NULL DEFAULT 0,last_error TEXT);''')
  if 'coverage_started' not in {r[1] for r in self.db.execute('PRAGMA table_info(pump_cursors)')}:self.db.execute('ALTER TABLE pump_cursors ADD COLUMN coverage_started INTEGER NOT NULL DEFAULT 0')
 def record(self,signature,tx,*,finalized):
  if not finalized or tx.get('transaction',{}).get('signatures',[None])[0]!=signature:raise ValueError('finalized_identity_required')
  if type(tx.get('slot')) is not int or tx['slot']<0:raise ValueError('invalid_slot')
  with self.store.transaction():
   for index,event in enumerate(trades(tx)):
    coin=self.db.execute("SELECT launch FROM coins WHERE pool=? AND phase='pumpswap'",(event['pool'],)).fetchone()
    if not coin:continue
    buy=event['kind']=='BuyEvent';base=event['base_amount_out' if buy else 'base_amount_in'];quote=event['quote_amount_in' if buy else 'quote_amount_out'];stamp=event['timestamp']
    if base<=0 or quote<=0 or not 0<=stamp<=9223372036854775807:raise ValueError('invalid_trade_amount')
    values=(event['pool'],coin['launch'],tx['slot'],stamp,event['user'],int(buy),str(base),str(quote))
    old=self.db.execute('SELECT pool,launch,slot,time,trader,buy,base,quote FROM pump_trades WHERE signature=? AND event_index=?',(signature,index)).fetchone()
    if old and tuple(old)!=values:raise ValueError('conflicting_finalized_trade')
    self.db.execute('INSERT OR IGNORE INTO pump_trades VALUES(?,?,?,?,?,?,?,?,?,?)',(signature,index,*values))
 def candles(self,launch,interval=900,limit=100):
  if type(interval) is not int or interval not in (60,300,900,3600,14400,86400) or type(limit) is not int or not 1<=limit<=500:raise ValueError('invalid_candle_request')
  latest=self.db.execute('SELECT MAX(time) FROM pump_trades WHERE launch=?',(launch,)).fetchone()[0]
  if latest is None:return {'candles':[],'priceUnit':'SOL','volumeUnit':'lamports','scope':'finalized_pumpswap_trades'}
  start=(latest//interval-limit+1)*interval;rows=self.db.execute('SELECT rowid,* FROM pump_trades WHERE launch=? AND time>=? ORDER BY time,slot,rowid LIMIT 100001',(launch,start)).fetchall()
  if len(rows)>100000:raise ValueError('candle_query_too_large')
  bars={}
  with localcontext() as ctx:
   ctx.prec=60
   for row in rows:
    bucket=row['time']//interval*interval;price=Decimal(row['quote'])/Decimal(row['base'])/1000
    if bucket not in bars:bars[bucket]={'time':bucket,'open':price,'high':price,'low':price,'close':price,'volumeLamports':0,'trades':0}
    b=bars[bucket];b['high']=max(b['high'],price);b['low']=min(b['low'],price);b['close']=price;b['volumeLamports']+=int(row['quote']);b['trades']+=1
  output=[{k:str(v) if isinstance(v,Decimal) or k=='volumeLamports' else v for k,v in b.items()} for b in bars.values()]
  return {'candles':output,'priceUnit':'SOL','volumeUnit':'lamports','scope':'finalized_pumpswap_trades'}
 def summary(self,launch,now):
  if type(now) is not int or now<0:raise ValueError('invalid_time')
  rows=self.db.execute('SELECT buy,base,quote,trader FROM pump_trades WHERE launch=? AND time>=? AND time<=? LIMIT 100001',(launch,now-86400,now)).fetchall()
  if len(rows)>100000:raise ValueError('market_query_too_large')
  buys=sum(r['buy'] for r in rows);buy_volume=sum(int(r['quote']) for r in rows if r['buy']);sell_volume=sum(int(r['quote']) for r in rows if not r['buy'])
  latest=self.db.execute('SELECT base,quote,time,slot FROM pump_trades WHERE launch=? ORDER BY time DESC,slot DESC,rowid DESC LIMIT 1',(launch,)).fetchone()
  with localcontext() as ctx:
   ctx.prec=60;price=str(Decimal(latest['quote'])/Decimal(latest['base'])/1000) if latest else None
  return {'buys24h':buys,'sells24h':len(rows)-buys,'buyers24h':len({r['trader'] for r in rows if r['buy']}),'sellers24h':len({r['trader'] for r in rows if not r['buy']}),'buyVolumeLamports24h':str(buy_volume),'sellVolumeLamports24h':str(sell_volume),'volumeLamports24h':str(buy_volume+sell_volume),'lastExecutionPriceSol':price,'lastTradeTime':latest['time'] if latest else None,'lastTradeSlot':latest['slot'] if latest else None,'scope':'finalized_pumpswap_trades','asOf':now}
 def health(self):
  return {'pools':self.db.execute('SELECT COUNT(*) FROM pump_cursors').fetchone()[0],'errors':self.db.execute('SELECT COUNT(*) FROM pump_cursors WHERE last_error IS NOT NULL').fetchone()[0],'oldestPoll':self.db.execute('SELECT MIN(last_polled) FROM pump_cursors').fetchone()[0]}
 def poll(self,rpc,genesis,now,limit=5):
  if rpc.call('getGenesisHash',[])!=genesis:raise ValueError('wrong_network')
  if type(limit) is not int or not 1<=limit<=25:raise ValueError('invalid_limit')
  self.db.execute("INSERT OR IGNORE INTO pump_cursors(pool) SELECT pool FROM coins WHERE phase='pumpswap' AND pool IS NOT NULL")
  for cursor in self.db.execute('SELECT * FROM pump_cursors WHERE last_polled<? ORDER BY last_polled,pool LIMIT ?',(now-10,limit)).fetchall():
   try:
    entries=[];before=None
    for page in range(10):
     options={'limit':1000,'commitment':'finalized'}
     if cursor['signature']:options['until']=cursor['signature']
     if before:options['before']=before
     batch=rpc.call('getSignaturesForAddress',[cursor['pool'],options]);entries+=batch
     if len(batch)<1000:break
     before=batch[-1]['signature']
    else:raise ValueError('market_backlog_exceeded')
    for entry in reversed(entries):
     if entry.get('confirmationStatus')!='finalized':raise ValueError('not_finalized')
     if entry.get('err') is not None:continue
     tx=rpc.call('getTransaction',[entry['signature'],{'encoding':'json','commitment':'finalized','maxSupportedTransactionVersion':0}])
     if not tx or tx['slot']!=entry['slot']:raise ValueError('market_transaction_mismatch')
     self.record(entry['signature'],tx,finalized=True)
    self.db.execute('UPDATE pump_cursors SET signature=?,last_polled=?,last_error=NULL,coverage_started=CASE WHEN coverage_started=0 THEN ? ELSE coverage_started END WHERE pool=?',(entries[0]['signature'] if entries else cursor['signature'],now,now,cursor['pool']))
   except Exception as error:self.db.execute('UPDATE pump_cursors SET last_polled=?,last_error=? WHERE pool=?',(now,type(error).__name__,cursor['pool']))
