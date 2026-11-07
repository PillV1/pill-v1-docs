"""Exact candles across finalized curve trades and subsequent PumpSwap trades."""
import json
from decimal import Decimal,localcontext
class MarketHistory:
 def __init__(self,store):self.db=store.db
 def rows(self,launch,start=0,end=9223372036854775807):
  curve=self.db.execute("SELECT a.signature,a.event_index,a.slot,t.time,a.body FROM coin_activity a JOIN transaction_times t ON t.signature=a.signature AND t.slot=a.slot WHERE a.launch=? AND a.kind='TradeRecorded' AND t.time>=? AND t.time<=? LIMIT 100001",(launch,start,end)).fetchall()
  pool=self.db.execute('SELECT * FROM pump_trades WHERE launch=? AND time>=? AND time<=? LIMIT 100001',(launch,start,end)).fetchall()
  if len(curve)+len(pool)>100000:raise ValueError('market_query_too_large')
  rows=[]
  for r in curve:
   b=json.loads(r['body']);base=int(b['tokens']);quote=int(b['quote'])
   if base<=0 or quote<=0:continue
   rows.append({'signature':r['signature'],'event_index':r['event_index'],'slot':r['slot'],'time':r['time'],'buy':bool(b['buy']),'trader':b['trader'],'base':base,'quote':quote,'venue':'curve'})
  rows.extend(dict(r)|{'base':int(r['base']),'quote':int(r['quote']),'venue':'pumpswap'} for r in pool)
  return sorted(rows,key=lambda r:(r['time'],r['slot'],r['signature'],r['event_index']))
 def latest_time(self,launch):
  a=self.db.execute("SELECT MAX(t.time) FROM coin_activity a JOIN transaction_times t ON a.signature=t.signature AND a.slot=t.slot WHERE a.launch=? AND a.kind='TradeRecorded'",(launch,)).fetchone()[0]
  b=self.db.execute('SELECT MAX(time) FROM pump_trades WHERE launch=?',(launch,)).fetchone()[0]
  return max((v for v in (a,b) if v is not None),default=None)
 def missing_times(self,launch):return self.db.execute("SELECT COUNT(*) FROM coin_activity a LEFT JOIN transaction_times t ON a.signature=t.signature AND a.slot=t.slot WHERE a.launch=? AND a.kind='TradeRecorded' AND t.signature IS NULL",(launch,)).fetchone()[0]
 def candles(self,launch,interval=900,limit=100):
  if interval not in (60,300,900,3600,14400,86400) or type(limit) is not int or not 1<=limit<=500:raise ValueError('invalid_candle_request')
  latest=self.latest_time(launch);rows=[] if latest is None else self.rows(launch,max(0,(latest//interval-limit+1)*interval));bars={}
  with localcontext() as ctx:
   ctx.prec=60
   for row in rows:
    bucket=row['time']//interval*interval;price=Decimal(row['quote'])/Decimal(row['base'])/1000
    if bucket not in bars:bars[bucket]={'time':bucket,'open':price,'high':price,'low':price,'close':price,'volumeLamports':0,'trades':0}
    b=bars[bucket];b['high']=max(b['high'],price);b['low']=min(b['low'],price);b['close']=price;b['volumeLamports']+=row['quote'];b['trades']+=1
  return {'candles':[{k:str(v) if isinstance(v,Decimal) or k=='volumeLamports' else v for k,v in b.items()} for b in bars.values()],'priceUnit':'SOL','volumeUnit':'lamports','scope':'finalized_curve_and_pumpswap_trades','missingTimestampTrades':self.missing_times(launch)}
 def summary(self,launch,now):
  rows=self.rows(launch,max(0,now-86400),now);stamp=self.latest_time(launch);latest=self.rows(launch,stamp,stamp)[-1] if stamp is not None else None
  with localcontext() as ctx:
   ctx.prec=60;price=str(Decimal(latest['quote'])/Decimal(latest['base'])/1000) if latest else None
  buys=[r for r in rows if r['buy']];sells=[r for r in rows if not r['buy']]
  return {'buys24h':len(buys),'sells24h':len(sells),'buyers24h':len({r['trader'] for r in buys}),'sellers24h':len({r['trader'] for r in sells}),'volumeLamports24h':str(sum(r['quote'] for r in rows)),'lastExecutionPriceSol':price,'lastTradeTime':latest['time'] if latest else None,'lastTradeSlot':latest['slot'] if latest else None,'scope':'finalized_curve_and_pumpswap_trades','asOf':now}
 def trades_page(self,launch,limit=50,cursor=None):
  from projections import decode_cursor,encode_cursor
  if type(limit) is not int or not 1<=limit<=100:raise ValueError('invalid_limit')
  where='';values=[launch,launch]
  if cursor:
   slot,signature,index,previous=decode_cursor(cursor,'trades',[int,str,int,str])
   if previous!=launch:raise ValueError('cursor_filter_mismatch')
   where=' WHERE slot<? OR (slot=? AND (signature<? OR (signature=? AND event_index<?)))';values.extend([slot,slot,signature,signature,index])
  sql="""SELECT * FROM (
   SELECT a.signature,a.event_index,a.slot,t.time,json_extract(a.body,'$.trader') trader,json_extract(a.body,'$.buy') buy,CAST(json_extract(a.body,'$.tokens') AS TEXT) base,CAST(json_extract(a.body,'$.quote') AS TEXT) quote,'curve' venue
   FROM coin_activity a LEFT JOIN transaction_times t ON a.signature=t.signature AND a.slot=t.slot WHERE a.launch=? AND a.kind='TradeRecorded'
   UNION ALL SELECT signature,event_index,slot,time,trader,buy,base,quote,'pumpswap' venue FROM pump_trades WHERE launch=?
  )"""+where+' ORDER BY slot DESC,signature DESC,event_index DESC LIMIT ?'
  rows=[dict(row) for row in self.db.execute(sql,(*values,limit+1))];more=len(rows)>limit;rows=rows[:limit]
  cursor=encode_cursor('trades',[rows[-1]['slot'],rows[-1]['signature'],rows[-1]['event_index'],launch]) if more else None
  return {'trades':rows,'nextCursor':cursor,'scope':'finalized_curve_and_pumpswap_trades'}
