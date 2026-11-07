import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {addresses,tickerAddress,u64} from './instructions.mjs';
export const ORAO=new PublicKey('VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y');
const pda=(...seeds)=>PublicKey.findProgramAddressSync(seeds,ORAO)[0];
export const networkAddress=()=>pda(Buffer.from('orao-vrf-network-configuration'));
export function randomnessAddress(seed){if(!/^[a-f0-9]{64}$/.test(seed)||/^0+$/.test(seed))throw Error('invalid_vrf_seed');return pda(Buffer.from('orao-vrf-randomness-request'),Buffer.from(seed,'hex'))}
const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey:new PublicKey(pubkey),isWritable,isSigner});
const ix=(program,name,keys,data=[])=>new TransactionInstruction({programId:new PublicKey(program),keys,data:Buffer.concat([createHash('sha256').update(`global:${name}`).digest().subarray(0,8),...data])});
export function requestActivationInstruction({program,mint,payer,seed,oracleTreasury,maxFee}){return ix(program,'request_activation',[meta(payer,true,true),meta(addresses(program,mint).launch,true),meta(networkAddress(),true),meta(oracleTreasury,true),meta(randomnessAddress(seed),true),meta(ORAO),meta(SystemProgram.programId)],[Buffer.from(seed,'hex'),u64(maxFee)])}
export function activateInstruction({program,mint,payer,seed,ticker,randomness}){return ix(program,'activate',[meta(payer,false,true),meta(addresses(program,mint).launch,true),meta(randomness??randomnessAddress(seed)),meta(tickerAddress(program,ticker),true)])}
export async function readOracleConfig(connection){
 const account=await connection.getAccountInfo(networkAddress(),'finalized');
 const tag=createHash('sha256').update('account:NetworkState').digest().subarray(0,8);
 if(!account||!account.owner.equals(ORAO)||account.data.length<84||!account.data.subarray(0,8).equals(tag))throw Error('invalid_oracle_config');
 return {oracleTreasury:new PublicKey(account.data.subarray(40,72)).toBase58(),maxFee:account.data.readBigUInt64LE(72).toString()};
}

export async function activationFulfilled(connection,seed,payer){
 const account=await connection.getAccountInfo(randomnessAddress(seed),'finalized');
 if(!account)return false;
 const data=Buffer.from(account.data),tag=createHash('sha256').update('account:RandomnessV2').digest().subarray(0,8);
 if(!account.owner.equals(ORAO)||data.length<73||!data.subarray(0,8).equals(tag)||!data.subarray(9,41).equals(new PublicKey(payer).toBuffer())||!data.subarray(41,73).equals(Buffer.from(seed,'hex')))throw Error('invalid_randomness_account');
 if(data[8]===0)return false;
 if(data[8]!==1||data.length<137||!data.subarray(73,137).some(v=>v!==0))throw Error('invalid_randomness_result');
 return true;
}
