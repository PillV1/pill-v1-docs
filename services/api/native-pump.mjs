import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,NATIVE_MINT} from '@solana/spl-token';
import {PUMP_SDK,PUMP_PROGRAM_ID,OnlinePumpSdk,bondingCurvePda,canonicalPumpPoolPda,holderRewardsPda} from '@pump-fun/pump-sdk';
const tag=name=>createHash('sha256').update('event:'+name).digest().subarray(0,8),createTag=tag('CreateEvent'),tradeTag=tag('TradeEvent');
const program=PUMP_PROGRAM_ID.toBase58(),eventCpi=Buffer.from([228,69,165,46,81,203,154,29]);
const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
function unbase58(text){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of text){const i=alphabet.indexOf(c);if(i<0)throw Error('invalid_base58');n=n*58n+BigInt(i)}const bytes=[];while(n){bytes.unshift(Number(n&255n));n>>=8n}return Buffer.from([...Array(text.length-text.replace(/^1+/,'').length).fill(0),...bytes])}
// Read-only indexing accepts JSON version-1 messages without passing them through
// web3.js's version-0-only transaction deserializer. Signing paths are unchanged.
export async function nativeTransaction(connection,signature){
 const response=await connection._rpcRequest('getTransaction',[signature,{encoding:'json',commitment:'finalized',maxSupportedTransactionVersion:1}]);
 if(response.error){const error=Error('native_history_rpc_error');error.name='NativeHistoryRpcError';error.code=response.error.code;throw error;}
 const tx=response.result;
 if(tx==null)return null;
 if(tx.transaction?.signatures?.[0]!==signature||!Number.isSafeInteger(tx.slot)||!Array.isArray(tx.transaction.message?.accountKeys))throw Error('native_transaction_identity_mismatch');
 return tx;
}
export function nativeEvents(tx){
 if(!tx?.meta||tx.meta.err)return [];
 const message=tx.transaction.message;
 const rawKeys=Array.isArray(message.accountKeys)?[...message.accountKeys,...(tx.meta.loadedAddresses?.writable??[]),...(tx.meta.loadedAddresses?.readonly??[])].map(key=>new PublicKey(key)):null;
 const keys=rawKeys?{get:index=>rawKeys[index]}:message.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses});const payloads=[];
 for(const group of tx.meta.innerInstructions??[])for(const ix of group.instructions){if(keys.get(ix.programIdIndex)?.toBase58()!==program)continue;const raw=unbase58(ix.data);if(raw.subarray(0,8).equals(eventCpi))payloads.push(raw.subarray(8))}
 if(!payloads.length){const stack=[];for(const line of tx.meta.logMessages??[]){const invoke=line.match(/^Program (\w+) invoke \[\d+\]$/);if(invoke){stack.push(invoke[1]);continue}if(/^Program \w+ (success|failed:)/.test(line)){stack.pop();continue}if(stack.at(-1)===program&&line.startsWith('Program data: '))payloads.push(Buffer.from(line.slice(14),'base64'))}}
 return payloads.flatMap((bytes,index)=>{if(bytes.subarray(0,8).equals(createTag))return [{index,kind:'create',data:PUMP_SDK.decodeCreateEventBc(bytes.subarray(8))}];if(bytes.subarray(0,8).equals(tradeTag))return [{index,kind:'trade',data:PUMP_SDK.decodeTradeEventBc(bytes.subarray(8))}];return []});
}
export function verifyNativeCreate(event,mint,wallet){const e=event.data;if(event.kind!=='create'||e.mint.toBase58()!==mint||e.user.toBase58()!==wallet||!e.isHolderReward||e.isCashbackEnabled||e.isMayhemMode||!e.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)||![PublicKey.default.toBase58(),NATIVE_MINT.toBase58()].includes(e.quoteMint.toBase58())||!e.bondingCurve.equals(bondingCurvePda(new PublicKey(mint))))throw Error('not_native_holder_rewards_launch');return e}
export class NativePump {
 constructor({db,connection,identity}){
  Object.assign(this,{db,connection,identity});this.sdk=new OnlinePumpSdk(connection);this.busy=false;this.offset=0;
  db.exec(`CREATE TABLE IF NOT EXISTS native_pump(mint TEXT PRIMARY KEY,launch TEXT UNIQUE NOT NULL,signature TEXT UNIQUE NOT NULL,creator TEXT NOT NULL,initial_sale TEXT NOT NULL,initial_virtual_tokens TEXT NOT NULL,initial_virtual_quote TEXT NOT NULL,supply TEXT NOT NULL,created INTEGER NOT NULL,crowned_at INTEGER,head TEXT,scan_before TEXT,scan_head TEXT,draining INTEGER NOT NULL DEFAULT 0,last_checked INTEGER NOT NULL DEFAULT 0,last_error TEXT);
  CREATE TABLE IF NOT EXISTS native_pump_pending(seq INTEGER PRIMARY KEY AUTOINCREMENT,mint TEXT NOT NULL,signature TEXT NOT NULL,slot INTEGER NOT NULL,UNIQUE(mint,signature));`);
 }
 async status(){const g=await this.sdk.fetchGlobal();return {enabled:!!g.createV2Enabled&&!!g.isHolderRewardEnabled,mode:'holder-rewards',program,checkedAt:Date.now(),feeSchedule:'https://pump.fun/docs/fees'}}
 async register(session,{mint,signature},now){
  const {wallet}=this.identity.session(session,now);mint=new PublicKey(mint).toBase58();if(!mint.endsWith('piLL')||typeof signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))throw Error('invalid_native_registration');
  const existing=this.db.prepare('SELECT * FROM native_pump WHERE mint=?').get(mint);if(existing){if(existing.signature!==signature||existing.creator!==wallet)throw Error('native_registration_mismatch');return {launch:existing.launch,mint}}
  const tx=await nativeTransaction(this.connection,signature);if(!tx||tx.meta?.err)throw Error('native_launch_not_finalized');
  const events=nativeEvents(tx),event=events.find(e=>e.kind==='create'&&e.data.mint.toBase58()===mint);if(!event)throw Error('native_create_missing');const e=verifyNativeCreate(event,mint,wallet),launch=e.bondingCurve.toBase58();
  const account=await this.connection.getAccountInfo(e.bondingCurve,'finalized');if(!account?.owner.equals(PUMP_PROGRAM_ID))throw Error('invalid_native_curve');const curve=PUMP_SDK.decodeBondingCurve(account);if(!curve.isHolderReward||!curve.creator.equals(holderRewardsPda(new PublicKey(mint))))throw Error('invalid_holder_rewards_curve');
  this.db.exec('BEGIN IMMEDIATE');try{
   const concurrent=this.db.prepare('SELECT signature,creator,launch FROM native_pump WHERE mint=?').get(mint);if(concurrent){if(concurrent.signature!==signature||concurrent.creator!==wallet)throw Error('native_registration_mismatch');this.db.exec('COMMIT');return {launch:concurrent.launch,mint}}
   this.db.prepare('INSERT INTO native_pump(mint,launch,signature,creator,initial_sale,initial_virtual_tokens,initial_virtual_quote,supply,created,head) VALUES(?,?,?,?,?,?,?,?,?,?)').run(mint,launch,signature,wallet,e.realTokenReserves.toString(),e.virtualTokenReserves.toString(),e.virtualSolReserves.toString(),e.tokenTotalSupply.toString(),e.timestamp.toNumber(),signature);
   this.db.prepare("INSERT INTO coins(launch,mint,creator,treasury,phase,created_slot,last_slot,name,symbol,uri,version,metadata_slot) VALUES(?,?,?,?,'curve',?,?,?,?,?,2,?)").run(launch,mint,wallet,curve.creator.toBase58(),tx.slot,tx.slot,e.name,e.symbol,e.uri,tx.slot);
   this.db.prepare('INSERT INTO crown_progress(launch,sale_tokens,sold,supply,virtual_tokens,virtual_quote) VALUES(?,?,?,?,?,?)').run(launch,BigInt(e.realTokenReserves.toString()),0,BigInt(e.tokenTotalSupply.toString()),BigInt(e.virtualTokenReserves.toString()),BigInt(e.virtualSolReserves.toString()));
   const created={kind:'LaunchCreated',mint,launch,creator:wallet,treasury:curve.creator.toBase58(),nativePump:true};this.db.prepare('INSERT OR IGNORE INTO coin_activity VALUES(?,?,?,?,?,?)').run(signature,event.index,launch,tx.slot,'LaunchCreated',json(created));
   this.ingest(mint,signature,tx,events);this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error}
  return {launch,mint};
 }
 ingest(mint,signature,tx,events=nativeEvents(tx)){
  const row=this.db.prepare('SELECT * FROM native_pump WHERE mint=?').get(mint);if(!row||tx.meta?.err)return;
  if(tx.blockTime==null)throw Error('native_timestamp_missing');this.db.prepare('INSERT OR IGNORE INTO transaction_times VALUES(?,?,?)').run(signature,tx.slot,tx.blockTime);
  for(const event of events){const t=event.data;if(event.kind!=='trade'||t.mint.toBase58()!==mint)continue;
   if(![PublicKey.default.toBase58(),NATIVE_MINT.toBase58()].includes(t.quoteMint.toBase58()))throw Error('unsupported_native_quote');
   const body={kind:'TradeRecorded',launch:row.launch,mint,trader:t.user.toBase58(),buy:t.isBuy,tokens:t.tokenAmount.toString(),quote:t.solAmount.toString(),fee:t.fee.add(t.creatorFee).toString(),nativePump:true};
   const result=this.db.prepare('INSERT OR IGNORE INTO coin_activity VALUES(?,?,?,?,?,?)').run(signature,event.index,row.launch,tx.slot,'TradeRecorded',json(body));if(!result.changes)continue;
   const sold=BigInt(row.initial_sale)-BigInt(t.realTokenReserves.toString());
   this.db.prepare('UPDATE crown_progress SET sold=?,quote=? WHERE launch=?').run(sold,BigInt(t.realSolReserves.toString()),row.launch);
   if(sold*100n>=BigInt(row.initial_sale)*85n){this.db.prepare('UPDATE crown_progress SET crowned_slot=?,crowned_row=0 WHERE launch=? AND crowned_row IS NULL').run(tx.slot,row.launch);this.db.prepare('UPDATE native_pump SET crowned_at=COALESCE(crowned_at,?) WHERE mint=?').run(tx.blockTime,mint)}
   this.db.prepare('UPDATE coins SET last_slot=MAX(last_slot,?) WHERE mint=?').run(tx.slot,mint);
  }
 }
 async poll(){
  if(this.busy)return;this.busy=true;
  try{const rows=this.db.prepare("SELECT n.* FROM native_pump n JOIN coins c ON c.mint=n.mint WHERE c.phase='curve' ORDER BY n.last_checked LIMIT 8").all();
   for(const row of rows){try{await this.pollCoin(row);this.db.prepare('UPDATE native_pump SET last_checked=?,last_error=NULL WHERE mint=?').run(Date.now(),row.mint)}catch(error){this.db.prepare('UPDATE native_pump SET last_checked=?,last_error=? WHERE mint=?').run(Date.now(),error.name,row.mint)}}
  }finally{this.busy=false}
 }
 async pollCoin(row){
  if(!row.draining){
  const signatures=await this.connection.getSignaturesForAddress(new PublicKey(row.launch),{limit:100,until:row.head,...(row.scan_before?{before:row.scan_before}:{})},'finalized');
  this.db.exec('BEGIN IMMEDIATE');try{
   for(const s of signatures)if(!s.err)this.db.prepare('INSERT OR IGNORE INTO native_pump_pending(mint,signature,slot) VALUES(?,?,?)').run(row.mint,s.signature,s.slot);
   const head=row.scan_head??signatures[0]?.signature??row.head;
   this.db.prepare('UPDATE native_pump SET scan_head=?,scan_before=? WHERE mint=?').run(head,signatures.length===100?signatures.at(-1).signature:null,row.mint);this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error}
  if(signatures.length===100)return;
  this.db.prepare('UPDATE native_pump SET draining=1 WHERE mint=?').run(row.mint);
  }
  const pending=this.db.prepare('SELECT * FROM native_pump_pending WHERE mint=? ORDER BY seq DESC LIMIT 20').all(row.mint);
  for(const item of pending){const tx=await nativeTransaction(this.connection,item.signature);if(!tx)throw Error('native_history_unavailable');this.db.exec('BEGIN IMMEDIATE');try{this.ingest(row.mint,item.signature,tx);this.db.prepare('DELETE FROM native_pump_pending WHERE mint=? AND signature=?').run(row.mint,item.signature);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}}
  if(this.db.prepare('SELECT 1 FROM native_pump_pending WHERE mint=?').get(row.mint))return;
  this.db.prepare('UPDATE native_pump SET head=COALESCE(scan_head,head),scan_head=NULL,draining=0 WHERE mint=?').run(row.mint);
  const pool=canonicalPumpPoolPda(new PublicKey(row.mint)),account=await this.connection.getAccountInfo(pool,'finalized');
  if(account?.owner.toBase58()==='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')this.db.prepare("UPDATE coins SET phase='pumpswap',pool=? WHERE mint=?").run(pool.toBase58(),row.mint);
 }
 async rules(mint){
  mint=new PublicKey(mint).toBase58();const row=this.db.prepare('SELECT * FROM native_pump WHERE mint=?').get(mint);if(!row)throw Error('coin_not_found');const account=await this.connection.getAccountInfo(new PublicKey(row.launch),'finalized');if(!account?.owner.equals(PUMP_PROGRAM_ID))throw Error('invalid_native_curve');const c=PUMP_SDK.decodeBondingCurve(account),sale=BigInt(row.initial_sale),remaining=BigInt(c.realTokenReserves.toString()),sold=sale-remaining,vTokens=BigInt(c.virtualTokenReserves.toString()),vSol=BigInt(c.virtualQuoteReserves.toString()),supply=BigInt(c.tokenTotalSupply.toString()),endTokens=BigInt(row.initial_virtual_tokens)-sale;
  return {version:'pump',commitment:'finalized',nativePump:true,curveComplete:c.complete,feeMode:'native-holder-rewards',holderRewards:c.isHolderReward,graduated:this.db.prepare('SELECT phase FROM coins WHERE mint=?').get(mint).phase==='pumpswap',curve:{progressBps:Number(sold*10000n/sale),remainingTokensRaw:remaining.toString(),reserveLamports:c.realQuoteReserves.toString(),marketCapLamports:(vSol*supply/vTokens).toString(),estimatedGraduationMarketCapLamports:(BigInt(row.initial_virtual_quote)*BigInt(row.initial_virtual_tokens)*supply/(endTokens*endTokens)).toString()}};
 }
}
