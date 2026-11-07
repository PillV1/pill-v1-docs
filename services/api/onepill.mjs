import {MARKET_SCHEMA,attachMarket} from './onepill-market.mjs';
import {verifyProof,paymentData} from './onepill-proof.mjs';
import {PublicKey} from '@solana/web3.js';
export const CHAINS=['ethereum','base','bsc','robinhood','solana'];
const ipfsGateway=(process.env.IPFS_GATEWAY_ORIGIN||'https://ipfs.io').replace(/\/$/,'')+'/ipfs/';
const idPattern=/^0x[0-9a-f]{64}$/i,evm=/^0x[0-9a-f]{40}$/i;
export function standardLaunch(input,owner){
 const name=String(input.name??'').trim(),symbol=String(input.symbol??'').trim().toUpperCase(),metadataURI=String(input.metadataURI??'');
 if(!name||Buffer.byteLength(name)>32||! /^[A-Z0-9]{1,10}$/.test(symbol))throw Error('invalid_metadata');
 if(!/^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})(\/[^\s?#]*)?$/.test(metadataURI))throw Error('onepill_ipfs_metadata_required');
 if(!evm.test(input.creatorEvm)||/^0x0{40}$/i.test(input.creatorEvm))throw Error('onepill_evm_wallet_required');
 if(input.feeBps!==100)throw Error('onepill_fee_must_be_one_percent');
 new PublicKey(owner);
 // Do not forward arbitrary launch fields: this route is always the standard five-chain launch.
 return {name,symbol,metadataURI,creatorEvm:input.creatorEvm,creatorSol:owner,feeBps:input.feeBps,payChain:'base',chains:CHAINS,supplyMode:0,degen:false};
}
export class OnePill {
 constructor({db,identity,connection,fetcher=fetch,clock=()=>Math.floor(Date.now()/1000)}){
  Object.assign(this,{db,identity,connection,fetcher,clock});this.busy=false;this.inflight=new Map();db.exec(MARKET_SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS onepill_launches(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,input TEXT NOT NULL,quote TEXT NOT NULL,state TEXT NOT NULL,auth TEXT,payment TEXT,status TEXT,coin TEXT,created INTEGER NOT NULL,checked INTEGER NOT NULL DEFAULT 0,listed_slot INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS onepill_owner ON onepill_launches(owner,created)`);
 }
 async upstream(path,body){
  const response=await this.fetcher('https://www.pangea.trade/api/'+path,{method:body?'POST':'GET',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok){const error=Error('onepill_provider_error');error.providerStatus=response.status;error.publicMessage=String(data.error??data.message??'Pangea could not complete this step.').slice(0,400);throw error;}return data;
 }
 async metadata(uri){
  const response=await this.fetcher(ipfsGateway+uri.slice(7),{redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok||Number(response.headers.get('content-length')??0)>65536)throw Error('onepill_metadata_unavailable');
  const reader=response.body.getReader(),parts=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536)throw Error('onepill_metadata_too_large');parts.push(value);}}finally{await reader.cancel();}
  let metadata;try{metadata=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Error('invalid_metadata');}
  const image=typeof metadata.image==='string'&&/^ipfs:\/\/[a-zA-Z0-9/._-]+$/.test(metadata.image)?ipfsGateway+metadata.image.slice(7):null;
  return {name:metadata.name,symbol:metadata.symbol,description:String(metadata.description??'').slice(0,2000),image};
 }
 owner(session,now=this.clock()){return this.identity.session(session,now).wallet;}
 row(id){if(!idPattern.test(id??''))throw Error('invalid_launch_id');const row=this.db.prepare('SELECT * FROM onepill_launches WHERE id=?').get(id);if(!row)throw Error('onepill_not_found');return row;}
 own(session,id){const row=this.row(id);if(row.owner!==this.owner(session))throw Error('unauthenticated');return row;}
 publicRow(row){const input=JSON.parse(row.input),status=row.status?JSON.parse(row.status):null,coin=row.coin?JSON.parse(row.coin):null;return attachMarket(this.db,{id:row.id,onepill:true,name:input.name,symbol:input.symbol,creator:row.owner,feeBps:input.feeBps,description:input.displayMeta?.description??'',image:input.displayMeta?.image??null,metadataURI:input.metadataURI,state:row.state,created:row.created,listedSlot:row.listed_slot,status,chains:coin?.chains??status?.result?.live??{},slug:coin?.slug??null});}
 async prepare(session,input){
  const owner=this.owner(session),now=this.clock();if(!/^[a-zA-Z0-9-]{16,64}$/.test(input.requestId??''))throw Error('invalid_request_id');
  const existing=this.db.prepare('SELECT * FROM onepill_launches WHERE request_id=?').get(input.requestId);
  if(existing){if(existing.owner!==owner)throw Error('unauthenticated');return this.privateRow(existing);}
  if(this.db.prepare('SELECT COUNT(*) n FROM onepill_launches WHERE owner=? AND created>?').get(owner,now-3600).n>=6)throw Error('onepill_quote_rate_limit');
  const key=owner+':prepare';if(this.inflight.has(key))throw Error('onepill_request_in_progress');this.inflight.set(key,true);
  try{const launch=standardLaunch(input,owner),displayMeta=await this.metadata(launch.metadataURI);if(displayMeta.name!==launch.name||String(displayMeta.symbol??'').toUpperCase()!==launch.symbol)throw Error('onepill_metadata_name_mismatch');const quote=await this.upstream('v1/launch/prepare',launch);
   if(!idPattern.test(quote.launchId??'')||!quote.ticket||!quote.payerProof||quote.fee?.payment?.chain!=='base'||!evm.test(quote.fee.payment.collector??''))throw Error('onepill_invalid_quote');
   if(quote.name!==launch.name||quote.symbol!==launch.symbol||quote.metadataURI!==launch.metadataURI||quote.creatorSol!==owner||quote.creator?.toLowerCase()!==launch.creatorEvm.toLowerCase()||quote.factoryV3!==true||quote.launchChains?.length!==5||CHAINS.some(chain=>!quote.launchChains.includes(chain)||quote.legFees?.[chain]!==launch.feeBps)||quote.degen!==false||quote.pair||quote.v2?.payeeEvm||quote.v2?.payeeSol)throw Error('onepill_invalid_quote');
   if(quote.payerProof.signer?.toLowerCase()!==launch.creatorEvm.toLowerCase())throw Error('onepill_invalid_quote');
   this.db.prepare('INSERT INTO onepill_launches(id,owner,request_id,input,quote,state,created) VALUES(?,?,?,?,?,?,?)').run(quote.launchId,owner,input.requestId,JSON.stringify({...launch,displayMeta}),JSON.stringify(quote),'quoted',now);
   return this.privateRow(this.row(quote.launchId));
  }finally{this.inflight.delete(key);}
 }
 privateRow(row){return {...this.publicRow(row),quote:JSON.parse(row.quote),payment:row.payment?JSON.parse(row.payment):null,authorized:!!row.auth};}
 mine(session){return {launches:this.db.prepare('SELECT * FROM onepill_launches WHERE owner=? ORDER BY created DESC LIMIT 30').all(this.owner(session)).map(row=>this.privateRow(row))};}
 authorize(session,input){const row=this.own(session,input.id);if(row.state!=='quoted')throw Error('onepill_launch_already_started');const auth={};for(const key of ['payerAuth','creatorEvmAuth','creatorSolAuth'])if(input[key]){if(typeof input[key]!=='string'||input[key].length>300||! /^(0x[0-9a-f]+|[1-9A-HJ-NP-Za-km-z]+)$/i.test(input[key]))throw Error('invalid_signature');auth[key]=input[key];}if(!auth.payerAuth)throw Error('invalid_signature');const quote=JSON.parse(row.quote),launch=JSON.parse(row.input);verifyProof(quote.payerProof,auth.payerAuth,launch.creatorEvm,launch.creatorSol);for(const proof of quote.creatorProofs??[]){const key=proof.signer===launch.creatorSol?'creatorSolAuth':'creatorEvmAuth';verifyProof(proof,auth[key],launch.creatorEvm,launch.creatorSol);}this.db.prepare('UPDATE onepill_launches SET auth=? WHERE id=?').run(JSON.stringify(auth),row.id);return {ok:true};}
 async pay(session,id){
  const row=this.own(session,id);if(row.state!=='quoted'||!row.auth)throw Error('onepill_payment_already_started');
  if(JSON.parse(row.input).feeBps!==100)throw Error('onepill_fee_must_be_one_percent');
  if(this.inflight.has(id))throw Error('onepill_request_in_progress');this.inflight.set(id,true);
  try{const quote=JSON.parse(row.quote),launch=JSON.parse(row.input),payment=await this.upstream('v1/launch/pay',{ticket:quote.ticket,payer:launch.creatorEvm});
   const tx=payment.tx;if(!tx||Number(tx.chainId)!==8453||payment.from?.toLowerCase()!==launch.creatorEvm.toLowerCase()||tx.to?.toLowerCase()!==quote.fee.payment.collector.toLowerCase()||BigInt(tx.value)!==BigInt(quote.fee.payment.send)||tx.data?.toLowerCase()!==paymentData(id)||payment.validUntil<=this.clock())throw Error('onepill_invalid_payment');
   // Persist before the browser can send: a lost response must never cause a second payment.
   this.db.prepare("UPDATE onepill_launches SET payment=?,state='payment_pending',checked=? WHERE id=?").run(JSON.stringify(payment),this.clock(),id);return payment;
  }finally{this.inflight.delete(id);}
 }
 rejected(session,id){const row=this.own(session,id);if(row.state!=='payment_pending'||JSON.parse(row.payment??'{}').hash)throw Error('onepill_payment_status_uncertain');this.db.prepare("UPDATE onepill_launches SET state='quoted',payment=NULL WHERE id=?").run(id);return {ok:true};}
 paymentHash(session,input){const row=this.own(session,input.id);if(row.state!=='payment_pending'||!/^0x[0-9a-f]{64}$/i.test(input.hash??''))throw Error('invalid_payment_hash');const payment=JSON.parse(row.payment);if(payment.hash&&payment.hash!==input.hash)throw Error('onepill_payment_status_uncertain');payment.hash=input.hash;this.db.prepare('UPDATE onepill_launches SET payment=? WHERE id=?').run(JSON.stringify(payment),row.id);return {ok:true};}
 async submit(session,id){const row=this.own(session,id);return this.submitRow(row);}
 async submitRow(row){if(!['payment_pending','submitted'].includes(row.state))return this.publicRow(row);if(!row.auth)throw Error('onepill_authorization_required');const quote=JSON.parse(row.quote),input=JSON.parse(row.input);await this.upstream('v1/launch/submit',{ticket:quote.ticket,payer:input.creatorEvm,...JSON.parse(row.auth)});this.db.prepare("UPDATE onepill_launches SET state='submitted' WHERE id=? AND state='payment_pending'").run(row.id);return this.refresh(row.id,true);}
 async refresh(id,force=false){
  const row=this.row(id);if(!force&&this.clock()-row.checked<10)return this.publicRow(row);
  if(!['submitted','running','done','failed'].includes(row.state))return this.publicRow(row);
  if(this.inflight.has(id))return this.publicRow(row);this.inflight.set(id,true);
  try{const status=await this.upstream('v1/launch/status?launchId='+encodeURIComponent(id));if(status.launchId!==id||!['pending','running','done','failed'].includes(status.state))throw Error('onepill_invalid_status');
   let coin=null,listed=row.listed_slot;
   if(status.state==='done'){
    coin=await this.upstream('coin/'+encodeURIComponent(id));
    if(coin.launchId!==id||CHAINS.some(chain=>!coin.chains?.[chain]?.token||!coin.chains?.[chain]?.pool||coin.chains[chain].quote!=='native')||coin.tokenomics?.on)throw Error('onepill_invalid_completed_launch');
    if(!listed)listed=await this.connection.getSlot('finalized');
   }
   this.db.prepare('UPDATE onepill_launches SET state=?,status=?,coin=COALESCE(?,coin),checked=?,listed_slot=? WHERE id=?').run(status.state==='pending'?'submitted':status.state,JSON.stringify(status),coin?JSON.stringify(coin):null,this.clock(),listed,id);
   return this.publicRow(this.row(id));
  }finally{this.inflight.delete(id);}
 }
 list(){return {coins:this.db.prepare("SELECT * FROM onepill_launches WHERE state='done' AND coin IS NOT NULL ORDER BY created DESC LIMIT 100").all().map(row=>this.publicRow(row))};}
 async poll(){if(this.busy)return;this.busy=true;try{for(const row of this.db.prepare("SELECT * FROM onepill_launches WHERE state IN ('payment_pending','submitted','running') AND created>? AND checked<? ORDER BY checked LIMIT 3").all(this.clock()-86400,this.clock()-60)){try{if(row.state==='payment_pending')await this.submitRow(row);else await this.refresh(row.id);}catch{this.db.prepare('UPDATE onepill_launches SET checked=? WHERE id=?').run(this.clock(),row.id);}}}finally{this.busy=false;}}
}
