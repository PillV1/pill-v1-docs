export function decimalUnits(value,decimals=9){
 if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value)||value.length>40)throw Error('Enter a positive decimal amount.');
 const [whole,fraction='']=value.split('.');if(fraction.length>decimals)throw Error(`Use at most ${decimals} decimal places.`);
 return (BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'))).toString();
}
export function formatUnits(raw,decimals=9,places=4){
 if(raw==null)return '—';try{const n=BigInt(raw),base=10n**BigInt(decimals),whole=n/base,fraction=(n%base).toString().padStart(decimals,'0').slice(0,places).replace(/0+$/,'');return whole.toLocaleString('en-US')+(fraction?'.'+fraction:'')}catch{return '—'}
}
export const safeText=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createApi({base='/api',fetcher=fetch}={}){
 if(!base.startsWith('/')||base.startsWith('//'))throw Error('API must use the same origin.');
 async function request(path,{method='GET',body,token,signal}={}){
  const response=await fetcher(base.replace(/\/$/,'')+path,{method,credentials:'same-origin',cache:'no-store',signal:signal??AbortSignal.timeout(15000),headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  let data;try{data=await response.json()}catch{
   const messages={413:'The image upload is too large. Choose a picture under 4 MB.',431:'The server rejected the request headers. Refresh the page and reconnect your wallet.',429:'Too many requests. Please wait a minute.'};
   const error=Error(messages[response.status]??(response.status>=500?'The service is temporarily unavailable. Please try again shortly.':`Unexpected server response (HTTP ${response.status}). Please refresh and try again.`));error.status=response.status;throw error;
  }
  if(!response.ok){const e=Error(data.error??'Service unavailable.');e.status=response.status;throw e}return data;
 }
 const post=(path,body)=>request(path,{method:'POST',body});
 return {request,launchRules:mint=>request('/launch/rules?mint='+encodeURIComponent(mint)),capabilities:()=>request('/capabilities'),coins:(cursor,sort='new')=>request('/coins?limit=100'+(sort==='new'?'':'&sort='+encodeURIComponent(sort))+(cursor?'&cursor='+encodeURIComponent(cursor):'')),coin:id=>request('/coins/'+encodeURIComponent(id)),trades:(id,cursor)=>request('/coins/'+encodeURIComponent(id)+'/trades?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):'')),activity:(id,cursor)=>request('/coins/'+encodeURIComponent(id)+'/activity?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):'')),candles:(id,interval=900)=>request('/coins/'+encodeURIComponent(id)+'/candles?interval='+interval+'&limit=100'),stats:()=>request('/stats'),challenge:wallet=>post('/auth/challenge',{wallet}),verify:(id,signature)=>post('/auth/verify',{id,signature}),logout:()=>post('/auth/logout',{}),linkX:()=>post('/auth/x/start',{}),createIntent:body=>post('/launch/intents',body),intent:(id,token)=>request('/launch/intents/'+encodeURIComponent(id),{token}),prepare:body=>post('/trades/prepare',body),discussions:(mint,before)=>request('/discussions?mint='+encodeURIComponent(mint)+(before?'&before='+encodeURIComponent(before):'')),postDiscussion:(mint,text,image=null)=>post('/discussions',{mint,text,image}),likeDiscussion:(id,liked)=>post('/discussions/like',{id,liked}),report:(id,reason)=>post('/discussions/report',{id,reason}),raids:mint=>request('/social/raids?mint='+encodeURIComponent(mint)),proofs:(mint,owner)=>request('/social/proofs?mint='+encodeURIComponent(mint)+'&owner='+encodeURIComponent(owner)),submitPost:(mint,postId)=>post('/social/posts',{mint,postId}),usd:amount=>request('/quotes/usd?amount='+encodeURIComponent(amount))};
}
export function launchPayload(draft,{requestId,curve,validateAddress}){
 if(!draft.name?.trim()||new TextEncoder().encode(draft.name.trim()).length>32)throw Error('Give your coin a name of up to 32 bytes.');
 if(!/^[A-Za-z0-9]{1,10}$/.test(draft.ticker??''))throw Error('Use 1–10 letters or numbers for the ticker.');
 if(!/^(https:\/\/|ipfs:\/\/|ar:\/\/)/.test(draft.uri??'')||new TextEncoder().encode(draft.uri).length>200)throw Error('Add a published HTTPS, IPFS or Arweave metadata URI (up to 200 bytes).');
 const version=draft.version??'v1';
 if(!['v1','v1.1'].includes(version))throw Error('Choose Standard V1 or Advanced V1.1.');
 if(version==='v1'){
  const owner=validateAddress(draft.wallet);
  return {version,owner,refundAddress:owner,requestId,blockedWallets:[],config:{name:draft.name.trim(),ticker:draft.ticker.toUpperCase(),uri:draft.uri,beneficiary:owner,developerBuyLamports:decimalUnits(draft.devBuy||'0')}};
 }
 const cap=decimalUnits(draft.cap,2);if(BigInt(cap)<50n||BigInt(cap)>400n)throw Error('Wallet cap must be between 0.5% and 4%.');
 const owner=validateAddress(draft.wallet),blockedWallets=[...new Set((draft.blocked??'').split(/[\s,]+/).filter(Boolean).map(validateAddress))];if(blockedWallets.length>10000)throw Error('Limit the blocklist to 10,000 wallets.');
 return {version,owner,refundAddress:owner,requestId,blockedWallets,config:{...curve,name:draft.name.trim(),ticker:draft.ticker.toUpperCase(),uri:draft.uri,feeMode:draft.feeMode,maxWalletBps:cap,quickBond:draft.mode==='quick',transfersOpen:false,developerBuyLamports:decimalUnits(draft.devBuy||'0'),beneficiary:owner,blocked:[],appMode:'any',appAuthorities:[]}};
}
