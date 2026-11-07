import {cachedRead} from './read-cache.mjs';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,unpackAccount} from '@solana/spl-token';
import {addresses} from '../../sdk/src/instructions.mjs';
import {decodePosition} from '../../sdk/src/accounts.mjs';
export class Profiles {
 constructor({connection,db,identity,program}){Object.assign(this,{connection,db,identity,program:new PublicKey(program)});db.exec('CREATE TABLE IF NOT EXISTS wallet_profiles(wallet TEXT PRIMARY KEY,username TEXT COLLATE NOCASE UNIQUE,avatar TEXT,updated INTEGER NOT NULL)');this.cache=new Map();this.pending=new Map();this.balanceRead=cachedRead(key=>{const [mint,owner]=key.split(':');return this.balanceSnapshot(mint,owner)},{ttlMs:2000})}
 publicBatch(addresses){
  if(!Array.isArray(addresses)||addresses.length>100)throw Error('invalid_profile_batch');
  return {profiles:[...new Set(addresses)].map(address=>{const wallet=new PublicKey(address).toBase58(),profile=this.db.prepare('SELECT username,avatar FROM wallet_profiles WHERE wallet=?').get(wallet),linked=this.db.prepare('SELECT username FROM x_links WHERE wallet=?').get(wallet);return {wallet,username:profile?.username??linked?.username??null,avatar:profile?.avatar??null}})};
 }
 update(session,input,now){
  const {wallet}=this.identity.session(session,now);
  if(input.wallet!==undefined&&input.wallet!==wallet)throw Error('profile_owner_required');
  if(typeof input.username!=='string'||! /^[A-Za-z0-9_]{1,20}$/.test(input.username))throw Error('profile_name_invalid');
  const avatar=input.avatar??null;if(avatar!==null&&(typeof avatar!=='string'||!/^\/media\/[a-f0-9]{64}\.webp$/.test(avatar)))throw Error('invalid_image');
  const previous=this.db.prepare('SELECT updated FROM wallet_profiles WHERE wallet=?').get(wallet);if(previous&&now-previous.updated<10)throw Error('profile_update_rate_limit');
  try{this.db.prepare('INSERT INTO wallet_profiles(wallet,username,avatar,updated) VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET username=excluded.username,avatar=excluded.avatar,updated=excluded.updated').run(wallet,input.username,avatar,now)}catch(e){if(String(e.message).includes('UNIQUE'))throw Error('profile_name_taken');throw e}
  return {wallet,username:input.username,avatar,updated:now};
 }
 async balance(mintValue,ownerValue){const mint=new PublicKey(mintValue).toBase58(),owner=new PublicKey(ownerValue).toBase58();return this.balanceRead(mint+':'+owner)}
 async balanceSnapshot(mintValue,ownerValue){
  const mint=new PublicKey(mintValue),owner=new PublicKey(ownerValue),coin=this.db.prepare("SELECT * FROM coins WHERE mint=? AND phase IN ('curve','pumpswap')").get(mint.toBase58());if(!coin)throw Error('coin_not_found');
  const position=coin.version===11&&coin.phase==='curve',key=position?addresses(this.program,mint,owner).position:getAssociatedTokenAddressSync(mint,owner,false,coin.version===2?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID);
  const snap=await this.connection.getMultipleAccountsInfoAndContext([key],{commitment:'finalized'}),account=snap.value[0];let amount=0n;
  if(position)amount=decodePosition({account,address:key,program:this.program,mint,owner}).balance;
  else if(account){const token=unpackAccount(key,account,coin.version===2?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID);if(!token.mint.equals(mint)||!token.owner.equals(owner))throw Error('balance_identity_mismatch');amount=token.amount}
  return {balanceRaw:amount.toString(),slot:snap.context.slot,commitment:'finalized'};
 }
 async read(address,session,now){
  const owner=new PublicKey(address),wallet=owner.toBase58();let viewer=null;
  if(session)try{viewer=this.identity.session(session,now).wallet}catch(e){if(e.message!=='unauthenticated')throw e}
  const created=this.db.prepare("SELECT * FROM coins WHERE creator=? AND phase IN ('curve','pumpswap') ORDER BY created_slot DESC LIMIT 100").all(wallet);
  const linked=this.db.prepare('SELECT username FROM x_links WHERE wallet=?').get(wallet);const custom=this.db.prepare('SELECT username,avatar FROM wallet_profiles WHERE wallet=?').get(wallet);
  let held=null,holdingsError=null;try{held=await this.holdings(owner)}catch{holdingsError='Holdings could not be verified. Please retry.'}
  const replies=viewer===wallet?this.db.prepare('SELECT d.id,d.text,d.created,d.mint,c.launch,c.symbol FROM discussions d JOIN coins c ON c.mint=d.mint WHERE d.wallet=? AND d.hidden=0 ORDER BY d.id DESC LIMIT 100').all(wallet):null;
  return {wallet,username:custom?.username??linked?.username??null,avatar:custom?.avatar??null,displayName:custom?.username??null,created,held,holdingsError,replies,ownReplies:viewer===wallet,limit:100};
 }
 async holdings(owner){
  const wallet=owner.toBase58(),saved=this.cache.get(wallet);if(saved&&saved.expires>Date.now())return saved.value;
  if(this.pending.has(wallet))return this.pending.get(wallet);if(this.pending.size>=4)throw Error('profiles_busy');
  const task=this.snapshot(owner).then(value=>{if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value);this.cache.set(wallet,{value,expires:Date.now()+30000});return value}).finally(()=>this.pending.delete(wallet));this.pending.set(wallet,task);return task;
 }
 async snapshot(owner){
  const batches=await Promise.all([TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].map(programId=>this.connection.getParsedTokenAccountsByOwner(owner,{programId},'finalized')));const tokens={value:batches.flatMap(b=>b.value),context:{slot:Math.min(...batches.map(b=>b.context.slot))}};
  const positions=await this.connection.getProgramAccounts(this.program,{commitment:'finalized',withContext:true,filters:[{dataSize:136},{memcmp:{offset:8,bytes:owner.toBase58()}}]});
  if(tokens.value.length+positions.value.length>10000)throw Error('profile_too_large');
  const held=new Map(),add=(coin,amount)=>{if(!coin||amount<=0n)return;const old=held.get(coin.mint);held.set(coin.mint,{coin,amount:(old?.amount??0n)+amount})};
  for(const t of tokens.value){const info=t.account.data.parsed?.info;if(!info||info.owner!==owner.toBase58())throw Error('invalid_token_owner');const coin=this.db.prepare("SELECT * FROM coins WHERE mint=? AND phase IN ('curve','pumpswap')").get(info.mint);add(coin,BigInt(info.tokenAmount.amount))}
  for(const {pubkey,account} of positions.value){const launch=new PublicKey(account.data.subarray(40,72)).toBase58(),coin=this.db.prepare("SELECT * FROM coins WHERE launch=? AND version=11 AND phase IN ('curve','pumpswap')").get(launch);if(!coin)continue;const position=decodePosition({account,address:pubkey,program:this.program,mint:coin.mint,owner});add(coin,position.balance)}
  return [...held.values()].map(h=>({...h.coin,balanceRaw:h.amount.toString(),observedSlot:Math.min(tokens.context.slot,positions.context.slot)}));
 }
}
