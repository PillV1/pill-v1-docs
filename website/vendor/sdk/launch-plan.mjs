import {PublicKey,Transaction} from '@solana/web3.js';
import {createLaunchInstruction,addBlockedWalletInstruction,executeDeveloperBuyInstruction,serializePlan} from './instructions.mjs';
import {requestActivationInstruction,activateInstruction} from './activation.mjs';
import {integer} from './quotes.mjs';
const key=value=>new PublicKey(value).toBase58();
const PLACEHOLDER_BLOCKHASH='11111111111111111111111111111111';
export function transactionSize(instructions,payer){
 const tx=new Transaction({feePayer:new PublicKey(payer),recentBlockhash:PLACEHOLDER_BLOCKHASH}).add(...instructions);
 const message=tx.compileMessage();
 return message.serialize().length+1+64*message.header.numRequiredSignatures;
}
function stage(kind,instructions,payer){
 const bytes=transactionSize(instructions,payer);if(bytes>1232)throw Error('transaction_too_large');
 return {kind,estimatedWireBytes:bytes,instructions:serializePlan(instructions)};
}
// Deterministic unsigned launch plan; no keys generated, no deposits accepted.
// Every stage must finalize before proceeding to the next. Reconcile chain state
// after timeout; never rebuild a launch with a new mint automatically.
export function planLaunch({program,mint,payer,config,blockedWallets=[],activation,automatic=false}) {
 if(!Array.isArray(blockedWallets)||blockedWallets.length>20000)throw Error('invalid_blocklist');
 if(config.extraBlockedCount)throw Error('planner_owns_blocklist_count');
 const wallets=[...new Set([...(config.blocked??[]),...blockedWallets].map(key))].sort();
 if(wallets.length>10000)throw Error('blocklist_too_large');
 const beneficiary=key(config.beneficiary??payer);
 if(integer(config.developerBuyLamports??'0')>0n&&wallets.includes(beneficiary))throw Error('developer_is_blocked');
 // Small inline list leaves room for account keys and both creation signatures.
 let inlineCount=Math.min(8,wallets.length),creation;
 for(;;){const committed={...config,beneficiary,blocked:wallets.slice(0,inlineCount),extraBlockedCount:wallets.length-inlineCount};creation=createLaunchInstruction({program,mint,creator:payer,config:committed});if(transactionSize([creation],payer)<=1232)break;if(inlineCount===0)throw Error('launch_configuration_too_large');inlineCount--}
 const extra=wallets.slice(inlineCount);
 const stages=[stage('create_launch',[creation],payer)];
 let batch=[];
 for(const wallet of extra){
  const instruction=addBlockedWalletInstruction({program,mint,creator:payer,wallet});
  // Four uploads is a conservative compute bound in addition to the wire bound.
  if(batch.length===4||transactionSize([...batch,instruction],payer)>1232){stages.push(stage('upload_blocklist',batch,payer));batch=[]}
  batch.push(instruction);
 }
 if(batch.length)stages.push(stage('upload_blocklist',batch,payer));
 if(!activation)throw Error('activation_configuration_required');
 const request=requestActivationInstruction({program,mint,payer,...activation});
 if(automatic&&transactionSize([creation,request],payer)<=1232)stages[0]=stage('create_launch',[creation,request],payer);
 else stages.push(stage('request_activation',[request],payer));
 stages.push(stage('activate',[activateInstruction({program,mint,payer,ticker:config.ticker,...activation})],payer));
 const developerAllocation=integer(config.developerBuyLamports??'0')>0n?stage('execute_developer_buy',[executeDeveloperBuyInstruction({program,mint,creator:beneficiary,keeper:payer,ticker:config.ticker,ensure:true})],payer):null;
 return {version:1,program:key(program),mint:key(mint),payer:key(payer),beneficiary,blockedWalletCount:wallets.length,blockedPdaCount:extra.length,stages,developerAllocation,developerAllocationCondition:'after_final_upload_and_protection_window',rentAndNetworkFees:'must_be_quoted_separately',readyForBroadcast:false};
}
