import {cachedRead} from './read-cache.mjs';
import {createServer} from 'node:http';
import {isIP} from 'node:net';
const cookieName='launchpad_session';
function session(req){const bearer=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];if(bearer)return bearer;return (req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1)}
async function body(req,max=650000){if(!req.headers['content-type']?.startsWith('application/json'))throw Error('json_required');let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>max)throw Error('request_too_large');parts.push(part)}return JSON.parse(Buffer.concat(parts).toString('utf8'))}
import {DisplayPrice} from './display-price.mjs';
const displayPrice=new DisplayPrice();
export function application({mintReserve,onepill,nativePump,profiles,holders,capabilities,media,privy,launchRules,identity,launches,social,program,xClient,trading,community,usdQuotes,socialIdentity,origin,trustedLoopbackProxy=false,clock=()=>Math.floor(Date.now()/1000)}){
 const nativeStatus=nativePump?cachedRead(()=>nativePump.status(),{ttlMs:5000}):null;
 const expectedOrigin=new URL(origin).origin;let active=0;const buckets=new Map();
 const server=createServer(async(req,res)=>{
  const reply=(status,data,headers={})=>{const raw=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(raw)};
  if(active>=64)return reply(503,{error:'server_busy'});active++;
  try{
   const now=clock();let remote=req.socket.remoteAddress??'unknown';
   if(trustedLoopbackProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)){const forwarded=req.headers['x-real-ip'];if(typeof forwarded==='string'&&isIP(forwarded))remote=forwarded}

   if(buckets.size>10000)for(const [key,b] of buckets)if(b.reset<=now)buckets.delete(key);
   let bucket=buckets.get(remote);if(!bucket&&buckets.size>=10000)return reply(429,{error:'rate_limited'});if(!bucket||bucket.reset<=now){bucket={count:0,reset:now+60};buckets.set(remote,bucket)}
   if(++bucket.count>300)return reply(429,{error:'rate_limited'});
   if(!req.url||req.url.length>2048)return reply(414,{error:'uri_too_long'});
   const url=new URL(req.url,'http://localhost');
   if(req.method==='POST'&&req.headers.origin&&req.headers.origin!==expectedOrigin)return reply(403,{error:'origin_rejected'});
   if(capabilities&&req.method==='GET'&&url.pathname==='/capabilities')return reply(200,await capabilities());
   if(req.method==='GET'&&url.pathname==='/auth/config')return reply(200,{privyAppId:privy?.appId??null,xEnabled:!!(privy||xClient)});
   if(req.method==='GET'&&url.pathname==='/auth/x/status'){const user=identity.session(session(req),now);const x=identity.db.prepare('SELECT username FROM x_links WHERE wallet=?').get(user.wallet);return reply(200,{linked:!!x,username:x?.username??null})}
   if(req.method==='POST'&&url.pathname==='/auth/privy/x'){if(!privy)throw Error('privy_not_configured');const b=await body(req);return reply(200,await privy.link(session(req),b.identityToken,now))}
   if(req.method==='POST'&&url.pathname==='/launch/mint/reserve'){if(!mintReserve)throw Error('mint_reserve_unavailable');const input=await body(req,1024);return reply(200,mintReserve.claim(session(req),input.requestId,now))}
   if(req.method==='POST'&&url.pathname==='/media'){if(!media)throw Error('media_not_configured');identity.session(session(req),now);return reply(201,await media.publish(session(req),await body(req,5700000),now))}
   if(req.method==='GET'&&url.pathname.startsWith('/media/')){if(!media)throw Error('media_not_configured');const item=await media.get(url.pathname.slice(7));res.writeHead(200,{'Content-Type':item.type,'Content-Length':item.bytes.length,'Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(item.bytes)}
   if(profiles&&req.method==='GET'&&url.pathname==='/wallet-balance')return reply(200,await profiles.balance(url.searchParams.get('mint'),url.searchParams.get('wallet')));
   if(profiles&&req.method==='GET'&&url.pathname==='/profiles/public')return reply(200,profiles.publicBatch((url.searchParams.get('wallets')??'').split(',').filter(Boolean)));
   if(profiles&&req.method==='POST'&&url.pathname==='/profiles'){identity.session(session(req),now);const input=await body(req,4096);if(input.avatar){if(!/^\/media\/[a-f0-9]{64}\.webp$/.test(input.avatar))throw Error('invalid_image');if(!media)throw Error('media_not_configured');await media.get(input.avatar.slice(7))}return reply(200,profiles.update(session(req),input,now))}
   if(profiles&&req.method==='GET'&&url.pathname==='/profiles')return reply(200,await profiles.read(url.searchParams.get('wallet'),session(req),now));
   if(holders&&req.method==='GET'&&url.pathname==='/holders')return reply(200,await holders.read(url.searchParams.get('mint')));
   if(launchRules&&req.method==='GET'&&url.pathname==='/launch/rules')return reply(200,await launchRules(url.searchParams.get('mint')));
   if(req.method==='GET'&&url.pathname==='/quotes/sol-usd')return reply(200,await displayPrice.read());
   if(usdQuotes&&req.method==='GET'&&url.pathname==='/quotes/usd')return reply(200,await usdQuotes.convert(url.searchParams.get('amount')));
   if(req.method==='GET'&&url.pathname==='/health')return reply(200,{status:'running',launchPaymentsEnabled:launches.enabled,readyForFunds:false});
   if(req.method==='POST'&&url.pathname==='/auth/challenge'){const b=await body(req);return reply(200,identity.challenge(b.wallet,now))}
   if(req.method==='POST'&&url.pathname==='/auth/verify'){const b=await body(req),result=identity.authenticate(b.id,b.signature,now);return reply(200,{wallet:result.wallet,expires:result.expires},{'Set-Cookie':`${cookieName}=${result.session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`})}
   if(req.method==='POST'&&url.pathname==='/auth/logout'){identity.logout(session(req)??'');return reply(200,{ok:true},{'Set-Cookie':`${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`})}
   if(req.method==='POST'&&url.pathname==='/auth/x/start'){if(!xClient)throw Error('x_not_configured');return reply(200,{url:identity.beginX(session(req),xClient,now)})}
   if(req.method==='GET'&&url.pathname==='/auth/x/callback'){if(!xClient)throw Error('x_not_configured');return reply(200,await identity.finishX(session(req),url.searchParams.get('state'),url.searchParams.get('code'),xClient,now))}
   const socialAuth=url.pathname.match(/^\/auth\/launch\/(x|github)\/(start|callback)$/);
   if(socialAuth&&socialIdentity){const [,provider,action]=socialAuth;if(req.method==='POST'&&action==='start')return reply(200,{url:socialIdentity.begin(session(req),provider,now)});if(req.method==='GET'&&action==='callback')return reply(200,await socialIdentity.finish(session(req),provider,url.searchParams.get('state'),url.searchParams.get('code'),now));}
   if(socialIdentity&&req.method==='GET'&&url.pathname==='/launch/beneficiary')return reply(200,socialIdentity.resolve(url.searchParams.get('provider'),url.searchParams.get('id')));
   if(onepill&&req.method==='POST'&&url.pathname==='/launch/onepill/media'){if(!media)throw Error('media_not_configured');identity.session(session(req),now);return reply(201,await media.publish(session(req),await body(req,5700000),now,true));}
   if(onepill&&url.pathname.startsWith('/launch/onepill')){
    const action=url.pathname.slice('/launch/onepill/'.length);
    if(req.method==='GET'&&action==='coins')return reply(200,onepill.list());
    if(req.method==='GET'&&action==='mine')return reply(200,onepill.mine(session(req)));
    if(req.method==='GET'&&action==='status')return reply(200,await onepill.refresh(url.searchParams.get('id')));
    if(req.method==='POST'){
     const input=await body(req,24000),token=session(req);
     if(action==='prepare')return reply(200,await onepill.prepare(token,input));
     if(action==='authorize')return reply(200,onepill.authorize(token,input));
     if(action==='pay')return reply(200,await onepill.pay(token,input.id));
     if(action==='rejected')return reply(200,onepill.rejected(token,input.id));
     if(action==='payment')return reply(200,onepill.paymentHash(token,input));
     if(action==='submit')return reply(200,await onepill.submit(token,input.id));
    }
   }
   if(nativePump&&req.method==='GET'&&url.pathname==='/launch/native/status')return reply(200,await nativeStatus('status'));
   if(nativePump&&req.method==='POST'&&url.pathname==='/launch/native/register')return reply(200,await nativePump.register(session(req),await body(req,4096),now));
   if(req.method==='POST'&&url.pathname==='/launch/intents')return reply(201,await launches.create(await body(req),now));
   if(req.method==='GET'&&/^\/launch\/intents\/[a-f0-9]{48}$/.test(url.pathname))return reply(200,launches.status(url.pathname.split('/').at(-1),session(req)));
   if(req.method==='POST'&&url.pathname==='/trades/prepare'){if(!trading)throw Error('trading_not_configured');return reply(200,await trading.prepare(session(req),await body(req),now))}
   if(community&&req.method==='POST'&&url.pathname==='/discussions')return reply(201,community.post(session(req),await body(req),now));
   if(community&&req.method==='GET'&&url.pathname==='/discussions')return reply(200,community.list(url.searchParams.get('mint'),{limit:Number(url.searchParams.get('limit')??50),before:Number(url.searchParams.get('before')??Number.MAX_SAFE_INTEGER)},session(req),now));
   if(community&&req.method==='POST'&&url.pathname==='/discussions/like')return reply(200,community.like(session(req),await body(req),now));
   if(community&&req.method==='POST'&&url.pathname==='/discussions/report')return reply(200,community.report(session(req),await body(req),now));
   if(community&&req.method==='POST'&&url.pathname==='/discussions/moderate')return reply(200,community.moderate(session(req),await body(req),now));
   if(social&&req.method==='GET'&&url.pathname==='/social/raids')return reply(200,social.raids(url.searchParams.get('mint'),{before:Number(url.searchParams.get('before')??Number.MAX_SAFE_INTEGER),limit:Number(url.searchParams.get('limit')??50)}));
   if(social&&program&&req.method==='GET'&&url.pathname==='/social/proofs')return reply(200,social.proofs(program,url.searchParams.get('mint'),url.searchParams.get('owner'),{before:Number(url.searchParams.get('before')??Number.MAX_SAFE_INTEGER),limit:Number(url.searchParams.get('limit')??20)}));
   if(req.method==='POST'&&url.pathname==='/social/posts'){if(!social)throw Error('x_not_configured');const b=await body(req);return reply(202,social.submit(session(req),b.mint,b.postId,now))}
   return reply(404,{error:'not_found'});
  }catch(error){
   if(error.providerStatus){reply(error.providerStatus,{error:error.publicMessage,provider:'pangea'});return;}
   const message=/^[a-z][a-z0-9_]{1,70}$/.test(error.message??'')?error.message:'request_failed';
   const status=message==='unauthenticated'?401:message.includes('disabled')||message.includes('not_configured')||message.includes('unavailable')?503:400;
   if(!res.headersSent)reply(status,{error:message});
  }finally{active--}
 });
 server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=5000;server.maxHeadersCount=32;return server;
}
