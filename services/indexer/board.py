"""Bounded, numbered board pages across custom, Pump and OnePill launches."""
import json,math

def onepill_coin(db,row):
 data=dict(row);launch=json.loads(data['input']);coin=json.loads(data['coin']);meta=launch.get('displayMeta') or {}
 metric=db.execute('SELECT * FROM onepill_market WHERE id=?',(data['id'],)).fetchone() if db.execute("SELECT 1 FROM sqlite_master WHERE name='onepill_market'").fetchone() else None
 m=dict(metric) if metric else {}
 mint=coin['chains']['solana']['token']
 replies=db.execute('SELECT COUNT(*) FROM discussions WHERE mint=? AND hidden=0',(mint,)).fetchone()[0] if db.execute("SELECT 1 FROM sqlite_master WHERE name='discussions'").fetchone() else 0
 return {'id':data['id'],'launch':data['id'],'onepill':True,'phase':'onepill','name':launch['name'],'symbol':launch['symbol'],'creator':data['owner'],'description':meta.get('description',''),'image':meta.get('image'),'mint':mint,'chains':coin['chains'],'slug':coin.get('slug'),'created_slot':data['listed_slot'],'createdAt':data['created'],'bumpSlot':max(data['listed_slot'],m.get('last_slot',0)),'cap':m.get('cap_sol'),'replyCount':replies,'kingOfTheHill':{'qualified':bool(m.get('crowned_slot')),'crownedSlot':m.get('crowned_slot'),'crownedAt':m.get('crowned_at'),'progressBps':m.get('progress_bps',0),'targetLiquiditySol':45,'liquiditySol':m.get('liquidity_sol')}}

def board_page(projection,page=1,limit=48,sort='bump',direction='desc',search='',include_graduated=True):
 if type(page) is not int or page<1 or page>1000000 or not 1<=limit<=100 or sort not in ('bump','new','cap') or direction not in ('asc','desc') or len(search)>100:raise ValueError('invalid_board_page')
 db=projection.db
 cap="CASE WHEN p.virtual_tokens>p.sold AND p.supply>0 THEN (p.virtual_quote+p.quote)*1.0*p.supply/(p.virtual_tokens-p.sold)/1000000000 ELSE 0 END"
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='pump_trades'").fetchone():
  cap="CASE WHEN c.phase='pumpswap' THEN COALESCE((SELECT CAST(t.quote AS REAL)*p.supply/NULLIF(CAST(t.base AS REAL),0)/1e9 FROM pump_trades t WHERE t.launch=c.launch ORDER BY t.slot DESC,t.rowid DESC LIMIT 1),0) ELSE "+cap+' END'
 source="SELECT c.launch AS id,'curve' AS source,c.name,c.symbol,c.mint,c.phase,c.created_slot,"+projection._bump_sql()+" AS bumpSlot,"+cap+" AS cap FROM coins c LEFT JOIN crown_progress p ON p.launch=c.launch WHERE c.phase IN ('curve','pumpswap')"
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='onepill_launches'").fetchone():
  metric=bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='onepill_market'").fetchone())
  source+=" UNION ALL SELECT o.id,'onepill',json_extract(o.input,'$.name'),json_extract(o.input,'$.symbol'),json_extract(o.coin,'$.chains.solana.token'),'onepill',o.listed_slot,"+("MAX(o.listed_slot,COALESCE(m.last_slot,0)),COALESCE(m.cap_sol,0)" if metric else 'o.listed_slot,0')+" FROM onepill_launches o "+('LEFT JOIN onepill_market m ON m.id=o.id ' if metric else '')+"WHERE o.state='done' AND o.coin IS NOT NULL"
 where=[];params=[]
 if not include_graduated:where.append("phase!='pumpswap'")
 if search:
  where.append("(instr(lower(COALESCE(name,'')),?)>0 OR instr(lower(COALESCE(symbol,'')),?)>0 OR instr(lower(mint),?)>0)");params.extend([search.lower()]*3)
 query=' FROM ('+source+')'+(' WHERE '+' AND '.join(where) if where else '')
 total=db.execute('SELECT COUNT(*)'+query,params).fetchone()[0];pages=max(1,math.ceil(total/limit));page=min(page,pages)
 order={'bump':'bumpSlot','new':'created_slot','cap':'cap'}[sort]
 rows=db.execute('SELECT id,source'+query+' ORDER BY '+order+' '+direction+',id LIMIT ? OFFSET ?',(*params,limit,(page-1)*limit)).fetchall()
 items=[onepill_coin(db,db.execute('SELECT * FROM onepill_launches WHERE id=?',(r['id'],)).fetchone()) if r['source']=='onepill' else projection.coin(r['id']) for r in rows]
 king=projection.king_of_the_hill()
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='onepill_market'").fetchone():
  row=db.execute("SELECT o.* FROM onepill_launches o JOIN onepill_market m ON m.id=o.id WHERE o.state='done' AND m.crowned_slot IS NOT NULL ORDER BY m.crowned_slot DESC,o.id LIMIT 1").fetchone()
  if row:
   candidate=onepill_coin(db,row)
   if not king or (candidate['kingOfTheHill']['crownedSlot'] or 0)>(king['kingOfTheHill']['crownedSlot'] or 0):king=candidate
 return {'coins':items,'page':page,'pages':pages,'total':total,'pageSize':limit,'kingOfTheHill':king}
