import {createHash} from 'node:crypto';
import {PublicKey,TransactionInstruction,SystemProgram,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {addresses,PUMP_SWAP,u64} from './instructions.mjs';
const key=x=>new PublicKey(x),tag=n=>createHash('sha256').update(`account:${n}`).digest().subarray(0,8);
const pda=(...s)=>PublicKey.findProgramAddressSync(s,PUMP_SWAP)[0];
export const FEE_PROGRAM=key('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'),FEE_CONFIG=key('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');
function checked(account,owner,name,min){if(!account||account.executable||!key(account.owner).equals(owner)||account.data.length<min||name&&!account.data.subarray(0,8).equals(tag(name)))throw Error('invalid_pool_snapshot');return Buffer.from(account.data)}
function maximumFees(data){let offset=41;const fees=()=>{if(offset+24>data.length)throw Error('invalid_fee_config');const total=data.readBigUInt64LE(offset)+data.readBigUInt64LE(offset+8)+data.readBigUInt64LE(offset+16);offset+=24;return total};let maximum=fees();for(let list=0;list<2;list++){if(offset===data.length)return maximum;if(offset+4>data.length)throw Error('invalid_fee_config');const n=data.readUInt32LE(offset);offset+=4;if(n>512)throw Error('invalid_fee_config');for(let i=0;i<n;i++){offset+=16;const f=fees();if(f>maximum)maximum=f;}}if(offset+24<=data.length){const f=fees();if(f>maximum)maximum=f;}return maximum}
export function settlementQuote({budget,baseReserve,quoteReserve,effectiveQuote,lpSupply,feeBps,liquidity}){
 if(budget<=0n||budget>100000000n||baseReserve<=0n||effectiveQuote<=0n||quoteReserve<=0n||lpSupply<=0n||feeBps<0n||feeBps>1000n)throw Error('unsupported_pool_quote');
 const buy=liquidity?budget/2n:budget,net=buy*10000n/(10000n+feeBps),estimated=baseReserve*net/(effectiveQuote+net),minTokens=(estimated>2n?estimated-2n:0n)*99n/100n;
 if(minTokens===0n)throw Error('settlement_below_precision');
 let minLp=0n;if(liquidity){const byBase=minTokens*lpSupply/(baseReserve-minTokens),byQuote=(budget-buy)*lpSupply/(quoteReserve+buy);minLp=(byBase<byQuote?byBase:byQuote)*99n/100n;if(minLp===0n)throw Error('settlement_below_precision')}
 return {budget,minTokens,minLp};
}
export async function poolSettlementInstruction({connection,program,mint,operator,launch}){
 const a=addresses(program,mint),pool=key(launch.pool),base=getAssociatedTokenAddressSync(key(mint),pool,true),quote=getAssociatedTokenAddressSync(NATIVE_MINT,pool,true),global=pda(Buffer.from('global_config'));
 const snapshot=await connection.getMultipleAccountsInfoAndContext([pool,base,quote,global,FEE_CONFIG,SYSVAR_CLOCK_PUBKEY],{commitment:'finalized'}),[pa,ba,qa,ga,fa,ca]=snapshot.value;
 const p=checked(pa,PUMP_SWAP,'Pool',261),g=checked(ga,PUMP_SWAP,'GlobalConfig',907),f=checked(fa,FEE_PROGRAM,'FeeConfig',65),b=checked(ba,TOKEN_PROGRAM_ID,null,165),q=checked(qa,TOKEN_PROGRAM_ID,null,165),c=checked(ca,key('Sysvar1111111111111111111111111111111111111'),null,40);
 if(!key(p.subarray(43,75)).equals(key(mint))||!key(p.subarray(75,107)).equals(NATIVE_MINT)||!key(p.subarray(11,43)).equals(a.authority)||!key(p.subarray(139,171)).equals(base)||!key(p.subarray(171,203)).equals(quote)||!key(b.subarray(0,32)).equals(key(mint))||!key(q.subarray(0,32)).equals(NATIVE_MINT)||!key(b.subarray(32,64)).equals(pool)||!key(q.subarray(32,64)).equals(pool)||c.readBigUInt64LE()!==BigInt(snapshot.context.slot))throw Error('pool_identity_mismatch');
 const virtual=p.readBigUInt64LE(245)+(p.readBigInt64LE(253)<<64n),rawQuote=q.readBigUInt64LE(64),baseReserve=b.readBigUInt64LE(64),lpSupply=p.readBigUInt64LE(203);
 const available=launch.sniperFees>0n?launch.sniperFees:launch.coinFees,liquidity=launch.sniperFees===0n&&launch.args.feeMode==='liquidity',budget=available<100000000n?available:100000000n;
 // Buyback basis points split protocol fees; they are not an extra trade fee.
 if(g.readBigUInt64LE(899)>10000n)throw Error('invalid_buyback_share');
 const args=settlementQuote({budget,baseReserve,quoteReserve:rawQuote,effectiveQuote:rawQuote+virtual,lpSupply,feeBps:maximumFees(f),liquidity});
 const recipient=key(g.subarray(643,675)),buyback=getAssociatedTokenAddressSync(NATIVE_MINT,recipient,true),lp=key(p.subarray(107,139));
 if(!lp.equals(pda(Buffer.from('pool_lp_mint'),pool.toBuffer())))throw Error('invalid_pool_lp');
 const keys=[ [operator,true,true],[a.config],[a.launch,true],[mint,true],[NATIVE_MINT],[a.authority,true],[getAssociatedTokenAddressSync(key(mint),a.authority,true),true],[getAssociatedTokenAddressSync(NATIVE_MINT,a.authority,true),true],[pool,true],[global],[base,true],[quote,true],[pda(Buffer.from('user_volume_accumulator'),a.authority.toBuffer()),true],[FEE_CONFIG],[buyback,true],[pda(Buffer.from('__event_authority'))],[PUMP_SWAP],[lp,true],[getAssociatedTokenAddressSync(lp,a.authority,true,TOKEN_2022_PROGRAM_ID),true],[TOKEN_PROGRAM_ID],[TOKEN_2022_PROGRAM_ID],[ASSOCIATED_TOKEN_PROGRAM_ID],[SystemProgram.programId] ];
 return new TransactionInstruction({programId:key(program),keys:keys.map(([pubkey,isWritable=false,isSigner=false])=>({pubkey:key(pubkey),isWritable,isSigner})),data:Buffer.concat([createHash('sha256').update('global:settle_pool_fees').digest().subarray(0,8),u64(args.budget),u64(args.minTokens),u64(args.minLp),u64(BigInt(snapshot.context.slot)+20n)])});
}
