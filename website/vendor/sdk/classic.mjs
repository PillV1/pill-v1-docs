import {createHash} from 'node:crypto';
import {PublicKey,SystemProgram,SYSVAR_RENT_PUBKEY,TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,NATIVE_MINT,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {integer} from './quotes.mjs';
import {u64,metadataData,metadataAddress,METADATA_PROGRAM,PUMP_SWAP,createLaunchInstruction} from './instructions.mjs';
export const CLASSIC=Object.freeze({supply:1000000000000000n,saleTokens:793100000000000n,virtualTokens:1073000000000000n,virtualSol:30000000000n,feeBps:220n});
const key=x=>new PublicKey(x),tag=x=>createHash('sha256').update(`global:${x}`).digest().subarray(0,8);
const meta=(x,w=false,s=false)=>({pubkey:key(x),isWritable:w,isSigner:s});
const ceil=(a,b)=>(a+b-1n)/b;
export function classicAddresses(program,mint,owner){program=key(program);mint=key(mint);const [launch,bump]=PublicKey.findProgramAddressSync([Buffer.from('classic'),mint.toBuffer()],program);return {launch,bump,config:PublicKey.findProgramAddressSync([Buffer.from('config')],program)[0],vault:getAssociatedTokenAddressSync(mint,launch,true),walletTokens:owner?getAssociatedTokenAddressSync(mint,key(owner)):null};}
export function quoteClassic({sold,quote,side,tokens}){
 sold=integer(sold);quote=integer(quote);tokens=integer(tokens);
 if(sold>=CLASSIC.saleTokens||tokens===0n)throw Error('curve_closed_or_zero');
 let principal,fee,walletLamports;
 if(side==='buy'){
  if(tokens>CLASSIC.saleTokens-sold)throw Error('insufficient_reserves');
  principal=ceil((CLASSIC.virtualSol+quote)*tokens,CLASSIC.virtualTokens-sold-tokens);
  fee=ceil(principal*CLASSIC.feeBps,10000n);walletLamports=principal+fee;
 }else if(side==='sell'){
  if(tokens>sold)throw Error('insufficient_reserves');
  principal=(CLASSIC.virtualSol+quote)*tokens/(CLASSIC.virtualTokens-sold+tokens);
  fee=ceil(principal*CLASSIC.feeBps,10000n);walletLamports=principal-fee;
  if(principal>quote||walletLamports<=0n)throw Error('insufficient_reserves');
 }else throw Error('invalid_side');
 integer(principal);integer(walletLamports);return {tokens,principal,fee,walletLamports};
}
export function createClassicInstruction({program,mint,creator,name,symbol,uri}){
 metadataData(name,uri);
 if(typeof symbol!=='string'||!symbol||Buffer.byteLength(symbol)>10||/[\u0000-\u001f\u007f-\u009f]/u.test(symbol))throw Error('invalid_symbol');
 const text=s=>{const b=Buffer.from(s),l=Buffer.alloc(4);l.writeUInt32LE(b.length);return Buffer.concat([l,b]);};
 const a=classicAddresses(program,mint);
 return new TransactionInstruction({programId:key(program),keys:[meta(creator,true,true),meta(a.config),meta(mint,true,true),meta(a.launch,true),meta(a.vault,true),meta(TOKEN_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(SystemProgram.programId),meta(metadataAddress(mint),true),meta(METADATA_PROGRAM),meta(SYSVAR_RENT_PUBKEY)],data:Buffer.concat([tag('create_classic'),text(name),text(symbol),text(uri)])});
}
export function classicTradeInstruction({program,mint,trader,side,tokens,limit,deadlineSlot}){
 if(!['buy','sell'].includes(side))throw Error('invalid_side');
 const a=classicAddresses(program,mint,trader);
 return new TransactionInstruction({programId:key(program),keys:[meta(trader,true,true),meta(a.launch,true),meta(mint),meta(a.vault,true),meta(a.walletTokens,true),meta(TOKEN_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(SystemProgram.programId)],data:Buffer.concat([tag(`${side}_classic`),u64(tokens),u64(limit),u64(deadlineSlot)])});
}
// Version choice selects a different instruction/account family, not a cosmetic label.
export function createVersionedLaunchInstruction(input){
 if(input.version==='v1')return createClassicInstruction(input);
 if(input.version==='v1.1'){const ix=createLaunchInstruction(input);tag('create_v11').copy(ix.data,0);return ix;}
 throw Error('launch_version_required');
}
export function graduateClassicInstruction({program,mint,keeper}){
 mint=key(mint);program=key(program);const a=classicAddresses(program,mint);
 const pda=(p,...s)=>PublicKey.findProgramAddressSync(s,p)[0];
 const authority=pda(program,Buffer.from('migration'),a.launch.toBuffer());
 const pool=pda(PUMP_SWAP,Buffer.from('pool'),Buffer.from([1,0]),authority.toBuffer(),mint.toBuffer(),NATIVE_MINT.toBuffer());
 const lpMint=pda(PUMP_SWAP,Buffer.from('pool_lp_mint'),pool.toBuffer());
 const ata=(m,o,tp=TOKEN_PROGRAM_ID)=>getAssociatedTokenAddressSync(m,o,true,tp);
 return new TransactionInstruction({programId:program,keys:[meta(keeper,true,true),meta(a.launch,true),meta(mint,true),meta(NATIVE_MINT),meta(a.vault,true),meta(authority,true),meta(ata(mint,authority),true),meta(ata(NATIVE_MINT,authority),true),meta(pool,true),meta(pda(PUMP_SWAP,Buffer.from('global_config'))),meta(lpMint,true),meta(ata(lpMint,authority,TOKEN_2022_PROGRAM_ID),true),meta(ata(mint,pool),true),meta(ata(NATIVE_MINT,pool),true),meta(pda(PUMP_SWAP,Buffer.from('__event_authority'))),meta(PUMP_SWAP),meta(TOKEN_PROGRAM_ID),meta(TOKEN_2022_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(SystemProgram.programId)],data:tag('graduate_classic')});
}
export function decodeClassicLaunch({account,address,program,mint}){
 if(!account||account.executable||!key(account.owner).equals(key(program)))throw Error('account_owner_mismatch');
 const data=Buffer.from(account.data),expected=classicAddresses(program,mint);
 const accountTag=createHash('sha256').update('account:ClassicLaunch').digest().subarray(0,8);
 if(data.length<186||!data.subarray(0,8).equals(accountTag))throw Error('invalid_classic_account');
 let offset=8;const readKey=()=>{const k=new PublicKey(data.subarray(offset,offset+32));offset+=32;return k.toBase58();};const readU64=()=>{const n=data.readBigUInt64LE(offset);offset+=8;return n;};
 const l={version:'v1',creator:readKey(),mint:readKey(),treasury:readKey(),pool:readKey(),bump:data[offset++]};
 l.sold=readU64();l.quote=readU64();l.fees=readU64();const flag=data[offset++];if(flag>1)throw Error('invalid_bool');l.graduated=flag===1;l.sequence=readU64();l.buySlot=readU64();l.slotBought=readU64();
 if(!key(address).equals(expected.launch)||!key(l.mint).equals(key(mint))||l.bump!==expected.bump)throw Error('launch_identity_mismatch');
 if(l.sold>CLASSIC.saleTokens||data.subarray(offset).some(b=>b!==0))throw Error('invalid_classic_state');return l;
}

export function collectClassicFeesInstruction({program,mint,treasury}){const a=classicAddresses(program,mint);return new TransactionInstruction({programId:key(program),keys:[meta(a.launch,true),meta(treasury,true)],data:tag('collect_classic_fees')})}
