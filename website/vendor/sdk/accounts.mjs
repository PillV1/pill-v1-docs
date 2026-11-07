import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {addresses} from './instructions.mjs';

// Decode only accounts belonging to the configured deployment and expected PDA.
// Amounts are BigInt in memory; use jsonAccount at the HTTP/JSON boundary.
class Reader {
 constructor(data, name) {
  this.data=Buffer.from(data); this.offset=8;
  const tag=createHash('sha256').update(`account:${name}`).digest().subarray(0,8);
  if(!this.data.subarray(0,8).equals(tag)) throw Error('account_discriminator_mismatch');
 }
 bytes(n){if(this.offset+n>this.data.length)throw Error('truncated_account');const b=this.data.subarray(this.offset,this.offset+n);this.offset+=n;return b}
 u8(){return this.bytes(1)[0]}
 bool(){const n=this.u8();if(n>1)throw Error('invalid_bool');return n===1}
 u16(){return this.bytes(2).readUInt16LE()}
 u64(){return this.bytes(8).readBigUInt64LE()}
 i64(){return this.bytes(8).readBigInt64LE()}
 u128(){const lo=this.u64(),hi=this.u64();return lo+(hi<<64n)}
 key(){return new PublicKey(this.bytes(32)).toBase58()}
 text(max){const n=this.bytes(4).readUInt32LE();if(n>max)throw Error('oversized_string');return this.bytes(n).toString('utf8')}
 ticker(){const n=this.bytes(4).readUInt32LE();if(n<1||n>10)throw Error('invalid_ticker');const s=this.bytes(n).toString('utf8');if(!/^[A-Z0-9]{1,10}$/.test(s))throw Error('invalid_ticker');return s}
 end(){if(this.data.subarray(this.offset).some(b=>b!==0))throw Error('unknown_account_version')}
}
function reader(account,program,name){
 if(!account||account.executable||!new PublicKey(account.owner).equals(new PublicKey(program)))throw Error('account_owner_mismatch');
 return new Reader(account.data,name);
}
function equal(a,b){return new PublicKey(a).equals(new PublicKey(b))}
export function decodeLaunch({account,address,program,mint}) {
 const r=reader(account,program,'Launch');
 const l={launcher:r.key(),creator:r.key(),mint:r.key(),treasury:r.key(),pool:r.key(),bump:r.u8()};
 if(!equal(l.mint,mint)||!equal(address,addresses(program,mint).launch))throw Error('launch_identity_mismatch');
 const a={ticker:r.ticker()};
 for(const k of ['supply','saleTokens','virtualTokens','virtualQuote','targetQuote','maxWalletBps','protectionSlots'])a[k]=r.u64();
 a.feeMode=['burn','holders','liquidity','yap','creator'][r.u8()];if(!a.feeMode)throw Error('invalid_fee_mode');
 const count=r.bytes(4).readUInt32LE();if(count>32)throw Error('invalid_blocklist');a.blocked=Array.from({length:count},()=>r.key());
 a.transfersOpen=r.bool();a.quickBond=r.bool();a.extraBlockedCount=r.u16();a.developerBuyLamports=r.u64();a.beneficiary=r.key();a.name=r.text(32);a.uri=r.text(200);a.appMode=['any','only','exclude'][r.u8()];const apps=r.bytes(4).readUInt32LE();if(!a.appMode||apps>8)throw Error('invalid_app_policy');a.appAuthorities=Array.from({length:apps},()=>r.key());l.args=a;
 l.startSlot=r.u64();l.createdAt=r.i64();
 for(const k of ['sold','quote','treasuryFees','coinFees'])l[k]=r.u64();
 l.graduated=r.bool();l.sequence=r.u64();l.burned=r.u64();l.rewardIndex=r.u128();l.rewardWaiting=r.u64();l.blockedUploaded=r.u16();
 l.sniperFees=r.u64();l.sniperTaxTotal=r.u64();l.developerBudget=r.u64();l.developerExecuted=r.bool();l.randomnessRequest=r.key();l.activationRequested=r.bool();l.randomnessReady=r.bool();l.cancelled=r.bool();l.graduatedAt=r.i64();l.buySlot=r.u64();l.slotBought=r.u64();r.end();return l;
}
export function decodePosition({account,address,program,mint,owner}) {
 const expected=addresses(program,mint,owner);
 if(!equal(address,expected.position))throw Error('position_address_mismatch');
 if(account===null)return {owner:new PublicKey(owner).toBase58(),launch:expected.launch.toBase58(),balance:0n,locked:0n,unlockAt:0n,rewardCheckpoint:0n,rewardFractional:0n,rewardClaimable:0n};
 const r=reader(account,program,'Position'),p={owner:r.key(),launch:r.key(),balance:r.u64(),locked:r.u64(),unlockAt:r.i64(),rewardCheckpoint:r.u128(),rewardFractional:r.u128(),rewardClaimable:r.u64()};
 if(!equal(p.owner,owner)||!equal(p.launch,expected.launch))throw Error('position_identity_mismatch');r.end();return p;
}
export function jsonAccount(value){return JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v))}

export function decodeConfig({account,address,program}){
 const expected=PublicKey.findProgramAddressSync([Buffer.from('config')],new PublicKey(program));
 if(!equal(address,expected[0]))throw Error('config_address_mismatch');
 const r=reader(account,program,'Config'),config={treasury:r.key(),bump:r.u8(),operator:r.key()};
 if(config.bump!==expected[1])throw Error('config_bump_mismatch');r.end();return config;
}
