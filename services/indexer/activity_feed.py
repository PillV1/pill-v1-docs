"""Latest finalized launch and trade events for indexed Pill coins only."""
import json

def activity_feed(db,limit=50):
 if type(limit) is not int or not 1<=limit<=100:raise ValueError('invalid_limit')
 rows=db.execute("""SELECT a.signature,a.event_index,a.slot,a.kind,a.body,t.time,c.launch,c.mint,c.creator,c.name,c.symbol,c.uri
 FROM coin_activity a JOIN coins c ON c.launch=a.launch LEFT JOIN transaction_times t ON t.signature=a.signature AND t.slot=a.slot
 WHERE a.kind IN ('TradeRecorded','LaunchCreated') AND c.phase IN ('curve','pumpswap') ORDER BY a.slot DESC,a.signature DESC,a.event_index DESC LIMIT ?""",(limit,)).fetchall()
 items=[]
 for row in rows:
  body=json.loads(row['body']);trade=row['kind']=='TradeRecorded'
  if trade and (int(body.get('quote',0))<=0 or int(body.get('tokens',0))<=0):continue
  items.append({k:row[k] for k in ('signature','event_index','slot','time','launch','mint','name','symbol','uri')}|{'type':('buy' if body['buy'] else 'sell') if trade else 'launch','wallet':body['trader'] if trade else row['creator'],'quoteLamports':str(body['quote']) if trade else None,'venue':'curve'})
 for row in db.execute("""SELECT p.*,c.mint,c.name,c.symbol,c.uri FROM pump_trades p JOIN coins c ON c.launch=p.launch WHERE c.phase='pumpswap' ORDER BY p.slot DESC,p.signature DESC,p.event_index DESC LIMIT ?""",(limit,)):
  items.append({k:row[k] for k in ('signature','event_index','slot','time','launch','mint','name','symbol','uri')}|{'type':'buy' if row['buy'] else 'sell','wallet':row['trader'],'quoteLamports':str(row['quote']),'venue':'pumpswap'})
 items.sort(key=lambda r:(r['slot'],r['signature'],r['event_index']),reverse=True)
 items=items[:limit]
 if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='x_links'").fetchone():
  for item in items:
   linked=db.execute('SELECT username FROM x_links WHERE wallet=?',(item['wallet'],)).fetchone();item['username']=linked['username'] if linked else None
 return {'items':items,'scope':'finalized_pill_launches_and_trades'}
