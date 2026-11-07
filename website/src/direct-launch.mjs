import {Connection,PublicKey,Keypair,Transaction,TransactionInstruction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {planLaunch} from '../vendor/sdk/launch-plan.mjs';
import {readOracleConfig,activationFulfilled} from '../vendor/sdk/activation.mjs';
import {createClassicInstruction,collectClassicFeesInstruction} from '../vendor/sdk/classic.mjs';
import {serializePlan} from '../vendor/sdk/instructions.mjs';
import {addresses} from '../vendor/sdk/instructions.mjs';
import {decodeConfig,decodeLaunch} from '../vendor/sdk/accounts.mjs';
import {base58} from './base58.mjs';
import {validateWalletResponse} from './wallet-response.mjs';
import {generateVanityMint} from './vanity-mint.mjs';
import {classicInitialBuy} from './classic-initial-buy.mjs';
const mintSigners=new Map();
const encoded=b=>Buffer.from(b).toString('base64');
export function assertLaunchIdentity(config,record,owner){
 if(!config.directLaunchEnabled||!config.program||!config.genesis||!config.rpcUrl||!config.treasury||!config.operator)throw Error('Direct launches are not enabled for this deployment.');
 if(record.owner!==owner||record.program!==config.program||record.genesis!==config.genesis||record.payload.config.beneficiary!==owner)throw Error('Launch wallet or deployment does not match.');
}
async function rpcFor(config){
 if(!config.program||!config.genesis||!config.rpcUrl||!config.treasury||!config.operator||!config.directLaunchEnabled)throw Error('The launch contract is not deployed and configured yet.');
 const rpc=new Connection(config.rpcUrl,'confirmed');if(await rpc.getGenesisHash()!==config.genesis)throw Error('Wrong Solana network.');
 const program=new PublicKey(config.program),address=PublicKey.findProgramAddressSync([Buffer.from('config')],program)[0],snapshot=await rpc.getMultipleAccountsInfoAndContext([program,address],{commitment:'finalized'});
 if(!snapshot.value[0]?.executable)throw Error('Launch program is not deployed.');const actual=decodeConfig({account:snapshot.value[1],address,program});
 if(actual.treasury!==config.treasury||actual.operator!==config.operator)throw Error('Deployment authorities do not match.');return rpc;
}
export function plan(record,slot=0n){
 if(record.payload.version==='v1'){
  const c=record.payload.config;
  const instruction=createClassicInstruction({program:record.program,mint:record.mint,creator:record.owner,name:c.name,symbol:c.ticker,uri:c.uri});
  const buy=classicInitialBuy({program:record.program,mint:record.mint,owner:record.owner,amount:c.developerBuyLamports??'0',slot});
  return {stages:[{kind:'create_launch',instructions:serializePlan(buy?[instruction,buy.instruction,...(record.treasury?[collectClassicFeesInstruction({program:record.program,mint:record.mint,treasury:record.treasury})]:[])]:[instruction])}],blockedWalletCount:0};
 }
 return planLaunch({program:record.program,mint:record.mint,payer:record.owner,config:record.payload.config,blockedWallets:record.payload.blockedWallets,activation:record.activation,automatic:record.automatic===true})}
export const launchStageKinds=record=>stages(plan(record)).map(stage=>stage.kind);
const stages=p=>[...p.stages,...(p.developerAllocation?[p.developerAllocation]:[])];
export async function prepareDirectLaunch(config,payload,owner,options={}){
 if(payload.owner!==owner||payload.config.beneficiary!==owner)throw Error('Use your connected wallet for this launch.');
 const rpc=await rpcFor(config),oracle=payload.version==='v1'?{maxFee:'0'}:await readOracleConfig(rpc),seed=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),mint=await generateVanityMint(options);
 const record={treasury:config.treasury,version:1,automatic:config.automaticActivationEnabled===true&&payload.version!=='v1',owner,program:config.program,genesis:config.genesis,mint:mint.publicKey.toBase58(),payload,activation:{...oracle,seed},step:0,history:[],pending:null,createdAt:Date.now()};
 const p=plan(record);record.stageCount=stages(p).length;record.stageKinds=stages(p).map(stage=>stage.kind);record.blockedCount=p.blockedWalletCount;record.oracleFeeLamports=oracle.maxFee;
 mintSigners.set(record.mint,mint);return record;
}
export function classifyConfirmation(status){if(!status||status.confirmationStatus!=='finalized')return 'pending';return status.err?'failed':'finalized'}
export async function reconcileDirectLaunch(config,record,owner,persist){
 assertLaunchIdentity(config,record,owner);if(!record.pending)return record;
 const rpc=await rpcFor(config),result=await rpc.getSignatureStatuses([record.pending.signature],{searchTransactionHistory:true}),state=classifyConfirmation(result.value[0]);
 if(state==='pending')return record;
 record.history.push({...record.pending,state});record.pending=null;
 if(state==='finalized'){if(record.history.at(-1).kind==='create_launch')mintSigners.delete(record.mint);record.step++;record.failure=null}else record.failure='The transaction failed on chain. Review it before retrying this step.';
 persist(record);return record;
}
export async function advanceDirectLaunch(config,record,provider,persist,onProgress=()=>{}){
 const owner=provider.publicKey?.toBase58();assertLaunchIdentity(config,record,owner);const rpc=await rpcFor(config);
 if(record.pending){await reconcileDirectLaunch(config,record,owner,persist);if(record.pending)throw Error('This transaction is still pending. Check its status before another approval.');}
 if(record.failure)throw Error(record.failure);
 const slot=record.payload.version==='v1'?BigInt(await rpc.getSlot('confirmed')):0n;
 record.treasury=config.treasury;
 const p=plan(record,slot),all=stages(p),stage=all[record.step];if(!stage)return {done:true};
 if(config.automaticActivationEnabled===true&&['activate','execute_developer_buy'].includes(stage.kind)){
  const address=addresses(config.program,record.mint).launch,account=await rpc.getAccountInfo(address,'finalized'),launch=decodeLaunch({account,address,program:config.program,mint:record.mint});
  if(launch.cancelled)throw Error('This launch was cancelled.');
  if(stage.kind==='activate'?launch.randomnessReady:launch.developerExecuted){record.step++;persist(record);return {done:record.step>=all.length}}
  return {waiting:'Launching your coin… Completing protection and your initial purchase automatically.'};
 }
 if(stage.kind==='activate'&&!await activationFulfilled(rpc,record.activation.seed,owner))return {waiting:'Setting up launch protection… No action needed. Your next wallet confirmation will open automatically.'};
 if(stage.kind==='execute_developer_buy'){
  const address=addresses(config.program,record.mint).launch,account=await rpc.getAccountInfo(address,'finalized'),launch=decodeLaunch({account,address,program:config.program,mint:record.mint});
  if(launch.developerExecuted){record.step++;persist(record);return {done:true}}
  if(BigInt(await rpc.getSlot('finalized'))<launch.startSlot+launch.args.protectionSlots)return {waiting:'Waiting for launch protection to finish before your initial buy. No action needed.'};
 }
 const latest=await rpc.getLatestBlockhash('confirmed');const tx=new Transaction({feePayer:new PublicKey(owner),recentBlockhash:latest.blockhash});
 for(const instruction of stage.instructions){if(instruction.program!==config.program)throw Error('Unexpected launch program.');tx.add(new TransactionInstruction({programId:new PublicKey(instruction.program),keys:instruction.accounts.map(a=>({pubkey:new PublicKey(a.address),isSigner:a.signer,isWritable:a.writable})),data:Buffer.from(instruction.dataBase64,'base64')}))}
 if(stage.kind==='create_launch'){const mint=mintSigners.get(record.mint);if(!mint)throw Error('This unsigned mint draft expired. Review a new launch; no transaction was sent.');tx.partialSign(mint)}
 onProgress({state:'wallet',kind:stage.kind});
 const expected=Uint8Array.from(tx.serializeMessage()),signed=validateWalletResponse(expected,await provider.signTransaction(tx));
 onProgress({state:'confirming',kind:stage.kind});
 const wire=signed.serialize(),signature=base58(signed.signature);
 record.pending={signature,wire:encoded(wire),lastValidBlockHeight:latest.lastValidBlockHeight,blockhash:latest.blockhash,kind:stage.kind};persist(record);
 // Persist the exact signed transaction before submitting. Unknown outcomes do not re-sign.
 try{const returned=await rpc.sendRawTransaction(wire,{skipPreflight:false,maxRetries:2});if(returned!==signature)throw Error('Unexpected signature.');await rpc.confirmTransaction({signature,...latest},'finalized')}catch{return {waiting:'Transaction submitted or submission uncertain. Check its saved signature; do not start another launch.'}}
 await reconcileDirectLaunch(config,record,owner,persist);return {done:record.step>=all.length,waiting:record.pending?'Waiting for finality.':null};
}
