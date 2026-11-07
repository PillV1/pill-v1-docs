"""Local read API; no signer, upload, launch, refund or payment mutation endpoint."""
import argparse,json,sys,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
from urllib.parse import urlsplit,parse_qs
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'indexer'))
from coin_metadata import CoinMetadata
from store import Store
from projections import Projections
from board import board_page
from pump_market import PumpMarket
from market_history import MarketHistory
from activity_feed import activity_feed

def handler(store,projection,metadata=None):
 market=PumpMarket(store);history=MarketHistory(store);stats_cache={"until":0,"value":None}
 store.db.execute('CREATE INDEX IF NOT EXISTS activity_feed_order ON coin_activity(slot DESC,signature DESC,event_index DESC)')
 store.db.execute('CREATE INDEX IF NOT EXISTS pump_trade_bump ON pump_trades(launch,slot DESC)')
 store.db.execute('CREATE INDEX IF NOT EXISTS pump_buy_bump ON pump_trades(launch,slot DESC) WHERE buy=1')
 store.db.execute('CREATE INDEX IF NOT EXISTS pump_feed_order ON pump_trades(slot DESC,signature DESC,event_index DESC)')
 class Handler(BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def reply(self,status,body):
   raw=json.dumps(body,separators=(',',':')).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(raw)
  def do_GET(self):
   if len(self.path)>2048:return self.reply(414,{'error':'uri_too_long'})
   try:
    url=urlsplit(self.path);q=parse_qs(url.query,max_num_fields=8,keep_blank_values=True);limit=int(q.get('limit',['50'])[0])
    if any(len(v)!=1 for v in q.values()) or set(q)-{'limit','cursor','phase','interval','sort','page','direction','search','graduated'}:raise ValueError('invalid_query')
    if not 1<=limit<=100:raise ValueError('invalid_limit')
    if url.path=='/health':return self.reply(200,{'status':'development','readyForFunds':False,'contractsDeployed':False,'queue':store.health(),'market':market.health()})
    if url.path=='/capabilities':return self.reply(200,{'version':'0.5.0','launchVersions':['v1','v1.1'],'versionSelectionReady':False,'creatorVesting':'purchased_tokens_7d_cliff_30d_linear_excludes_holder_mode','socialLaunchIdentity':'not_configured','launchSafety':'offline_policy_only','readyForFunds':False,'supportedFeeModes':['burn','holders','liquidity','yap','creator'],'network':'unconfigured','trading':'unsigned_sdk_only','metadata':True,'renamePolicy':'holder_proposals_moderator_selection_24h_delay','yap':True,'appRestrictions':True,'publicLaunchPayments':False,'randomizedProtection':True,'graduationVenue':'pumpswap','postGraduationFees':'native_pumpswap','treasuryShareBps':1000})
    if url.path=='/coins/activity-feed':
     result=activity_feed(store.db,limit)
     if metadata:result['items']=[metadata.decorate(item) for item in result['items']]
     return self.reply(200,result)
    if url.path=='/coins/board':
     page=board_page(projection,int(q.get('page',['1'])[0]),limit,q.get('sort',['bump'])[0],q.get('direction',['desc'])[0],q.get('search',[''])[0],q.get('graduated',['1'])[0]!='0')
     if metadata:page['coins']=[c if c.get('onepill') else metadata.decorate(c) for c in page['coins']];page['kingOfTheHill']=page['kingOfTheHill'] if (page['kingOfTheHill'] or {}).get('onepill') else metadata.decorate(page['kingOfTheHill'])
     return self.reply(200,page)
    if url.path=='/coins':
     page=projection.coins_page(limit,q.get('cursor',[None])[0],q.get('phase',[None])[0],q.get('sort',['new'])[0])
     if metadata:page['coins']=[metadata.decorate(c) for c in page['coins']];page['kingOfTheHill']=metadata.decorate(page['kingOfTheHill'])
     return self.reply(200,page)
    if url.path=='/stats':
     now=int(time.time())
     if now>=stats_cache['until']:
      result=projection.stats();worker=store.db.execute("SELECT last_success,last_error FROM worker_state WHERE name='indexer'").fetchone()
      result['indexedAt']=worker[0] if worker else None;result['indexerHealthy']=bool(worker and worker[0] and not worker[1] and now-worker[0]<=30);result['checkedAt']=now
      stats_cache.update(until=now+3,value=result)
     return self.reply(200,stats_cache['value'])
    parts=url.path.strip('/').split('/')
    if len(parts) in (2,3) and parts[0]=='coins':
     launch=parts[1]
     if not launch or len(launch)>64:raise ValueError('invalid_launch')
     coin=projection.coin(launch)
     if coin is None:return self.reply(404,{'error':'coin_not_found'})
     if len(parts)==2:return self.reply(200,{'coin':metadata.decorate(coin) if metadata else coin,'market':history.summary(launch,int(time.time()))})
     if parts[2]=='candles':return self.reply(200,history.candles(launch,int(q.get('interval',['900'])[0]),limit))
     if parts[2]=='trades':return self.reply(200,history.trades_page(launch,limit,q.get('cursor',[None])[0]))
     if parts[2]=='activity':return self.reply(200,projection.activity_page(launch,limit,q.get('cursor',[None])[0]))
    return self.reply(404,{'error':'not_found'})
   except (ValueError,KeyError):return self.reply(400,{'error':'invalid_request'})
   except Exception:return self.reply(503,{'error':'read_service_unavailable'})
  def do_POST(self):return self.reply(503,{'error':'public_mutations_disabled'})
 return Handler
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--database',required=True);parser.add_argument('--port',type=int,default=8788);args=parser.parse_args()
 if not 1024<=args.port<=65535:raise ValueError('invalid_port')
 store=Store(args.database);projection=Projections(store)
 # Startup catch-up is bounded; the indexer maintains projections during normal operation.
 for _ in range(100):
  if projection.advance()<1000:break
 HTTPServer(('127.0.0.1',args.port),handler(store,projection,CoinMetadata(Path(args.database).parent/'media'))).serve_forever()
