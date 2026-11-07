import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,unpackAccount,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {addresses} from './instructions.mjs';
import {decodeLaunch,decodePosition} from './accounts.mjs';
// Eligibility is observed at finalized banks during round freezing, not claimed
// to be a historical snapshot at the end of the scoring hour.
export function holderReader(connection,expectedGenesis){
 return async({program,mint,wallets})=>{
  if(!expectedGenesis||await connection.getGenesisHash()!==expectedGenesis)throw Error('wrong_cluster');
  if(!Array.isArray(wallets)||wallets.length>10000||new Set(wallets).size!==wallets.length)throw Error('invalid_wallets');
  mint=new PublicKey(mint);const a=addresses(program,mint),out=[];
  for(let start=0;start<wallets.length;start+=48){
   const batch=wallets.slice(start,start+48).map(w=>new PublicKey(w));
   const keys=[a.launch,...batch.flatMap(w=>[addresses(program,mint,w).position,getAssociatedTokenAddressSync(mint,w)])];
   const snapshot=await connection.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized'});
   if(!Number.isSafeInteger(snapshot.context?.slot)||snapshot.value.length!==keys.length)throw Error('invalid_snapshot');
   const launch=decodeLaunch({account:snapshot.value[0],address:a.launch,program,mint});
   for(let i=0;i<batch.length;i++){
    const owner=batch[i],position=decodePosition({account:snapshot.value[1+i*2],address:keys[1+i*2],program,mint,owner});
    let balance=position.balance;const tokenInfo=snapshot.value[2+i*2];
    if(launch.graduated&&tokenInfo){const token=unpackAccount(keys[2+i*2],tokenInfo,TOKEN_PROGRAM_ID);if(!token.mint.equals(mint)||!token.owner.equals(owner))throw Error('token_identity_mismatch');balance+=token.amount}
    out.push({wallet:owner.toBase58(),balance:balance.toString(),slot:snapshot.context.slot,commitment:'finalized'});
   }
  }
  return out;
 };
}
