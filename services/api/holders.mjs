import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackAccount,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {addresses} from '../../sdk/src/instructions.mjs';
import {decodePosition} from '../../sdk/src/accounts.mjs';
// Only indexed Pill mints are accepted. Shared short-lived snapshots bound RPC load.
export class Holders {
 constructor({connection,db,program}){Object.assign(this,{connection,db,program:new PublicKey(program)});this.cache=new Map();this.pending=new Map();this.scanRetryAt=0}
 async read(value,now=Date.now()){
  const mint=new PublicKey(value),key=mint.toBase58();
  let coin=this.db.prepare("SELECT * FROM coins WHERE mint=? AND phase IN ('curve','pumpswap')").get(key);
  if(!coin&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='onepill_launches'").get()){const row=this.db.prepare("SELECT * FROM onepill_launches WHERE state='done' AND json_extract(coin,'$.chains.solana.token')=?").get(key);if(row)coin={launch:JSON.parse(row.coin).chains.solana.pool,creator:row.owner,phase:'onepill',version:2,onepill:true};}
  if(!coin)throw Error('coin_not_found');
  const saved=this.cache.get(key);if(saved&&saved.expires>now)return saved.value;
  if(this.pending.has(key))return this.pending.get(key);if(this.pending.size>=4)throw Error('holders_busy');
  const task=(Date.now()<this.scanRetryAt?this.indexedSnapshot(mint,coin):this.snapshot(mint,coin).catch(()=>{this.scanRetryAt=Date.now()+300000;return this.indexedSnapshot(mint,coin)})).then(value=>{if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,{value,expires:Date.now()+30000});return value}).finally(()=>this.pending.delete(key));this.pending.set(key,task);return task;
 }
 async indexedSnapshot(mint,coin){
  // Public RPC providers may disable largest-account scans. Verify balances for
  // known traders directly; this is explicitly a partial view, not all holders.
  const rows=this.db.prepare("SELECT DISTINCT wallet FROM (SELECT json_extract(body,'$.trader') wallet FROM coin_activity WHERE launch=? AND kind='TradeRecorded' UNION SELECT trader wallet FROM pump_trades WHERE launch=?) LIMIT 101").all(coin.launch,coin.launch);
  const owners=[...new Set([coin.creator,coin.launch,...rows.map(r=>r.wallet)].filter(Boolean))].slice(0,100).map(v=>new PublicKey(v));
  const receipt=coin.version===11&&coin.phase==='curve';
  const keys=owners.map(owner=>receipt?addresses(this.program,mint,owner).position:getAssociatedTokenAddressSync(mint,owner,true,coin.version===2?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID));
  const result=await this.connection.getMultipleAccountsInfoAndContext([mint,...keys],{commitment:'finalized'});
  const supply=result.value[0];if(!supply||!supply.owner.equals(coin.version===2?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID)||supply.data.length<82)throw Error('invalid_mint');
  const total=supply.data.readBigUInt64LE(36);
  const holders=owners.flatMap((owner,i)=>{const account=result.value[i+1];if(!account)return [];let amount;if(receipt){amount=decodePosition({account,address:keys[i],program:this.program,mint,owner}).balance}else{const token=unpackAccount(keys[i],account,coin.version===2?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID);if(!token.mint.equals(mint)||!token.owner.equals(owner))throw Error('holder_mint_mismatch');amount=token.amount}return amount>0n?[{account:keys[i].toBase58(),wallet:owner.toBase58(),amount}]:[]}).sort((a,b)=>a.amount===b.amount?0:a.amount>b.amount?-1:1).slice(0,20);
  return {holders:holders.map(h=>({...h,amount:h.amount.toString(),supplyBps:total?Number(h.amount*10000n/total):0,role:h.wallet===coin.creator?'dev':h.wallet===coin.launch?'bonding curve':null})),slot:result.context.slot,totalSupplyRaw:total.toString(),scope:'indexed_participants',partial:true,commitment:'finalized'};
 }
 async snapshot(mint,coin){
  const supply=await this.connection.getTokenSupply(mint,'finalized'),total=BigInt(supply.value.amount);let holders,slot=supply.context.slot;
  if(coin.version===11&&coin.phase==='curve'){
   const launch=addresses(this.program,mint).launch;
   const accounts=await this.connection.getProgramAccounts(this.program,{commitment:'finalized',withContext:true,filters:[{dataSize:136},{memcmp:{offset:40,bytes:launch.toBase58()}}]});
   if(!Array.isArray(accounts.value)||accounts.value.length>10000)throw Error('holders_snapshot_unavailable');slot=Math.min(slot,accounts.context.slot);
   holders=accounts.value.map(({pubkey,account})=>{const owner=new PublicKey(account.data.subarray(8,40));const position=decodePosition({account,address:pubkey,program:this.program,mint,owner});return {account:pubkey.toBase58(),wallet:owner.toBase58(),amount:position.balance}}).filter(h=>h.amount>0n).sort((a,b)=>a.amount===b.amount?a.wallet.localeCompare(b.wallet):a.amount>b.amount?-1:1).slice(0,20);
  }else{
   const largest=await this.connection.getTokenLargestAccounts(mint,'finalized');const rows=largest.value.filter(x=>BigInt(x.amount)>0n);
   if(!rows.length)return {holders:[],slot,totalSupplyRaw:total.toString(),scope:'largest_token_accounts',commitment:'finalized'};
   const snapshot=await this.connection.getMultipleAccountsInfoAndContext(rows.map(x=>x.address),{commitment:'finalized',minContextSlot:largest.context.slot});slot=Math.min(slot,snapshot.context.slot);
   holders=rows.map((row,i)=>{const a=unpackAccount(row.address,snapshot.value[i],coin.version===2?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID);if(!a.mint.equals(mint))throw Error('holder_mint_mismatch');return {account:row.address.toBase58(),wallet:a.owner.toBase58(),amount:a.amount}});
  }
  return {holders:holders.map(h=>({...h,amount:h.amount.toString(),supplyBps:total?Number(h.amount*10000n/total):0,role:h.wallet===coin.creator?'dev':h.wallet===coin.launch?'bonding curve':null})),slot,totalSupplyRaw:total.toString(),scope:coin.version===11&&coin.phase==='curve'?'largest_program_positions':'largest_token_accounts',commitment:'finalized'};
 }
}
