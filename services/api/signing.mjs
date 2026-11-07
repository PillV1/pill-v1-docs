import {createHmac,createHash} from 'node:crypto';
import {Keypair,PublicKey,Transaction,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {activationFulfilled} from '../../sdk/src/activation.mjs';
import {decodeLaunch} from '../../sdk/src/accounts.mjs';
import {addresses,cancelLaunchInstruction} from '../../sdk/src/instructions.mjs';
import {planLaunch} from '../../sdk/src/launch-plan.mjs';
import {integer} from '../../sdk/src/quotes.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n}for(const b of bytes){if(b!==0)break;s='1'+s}return s}
export class SignerVault {
 #master;#scope;
 constructor(master,{program,genesis}){if(!Buffer.isBuffer(master)||master.length!==32||!genesis)throw Error('invalid_vault_configuration');this.#master=Buffer.from(master);this.#scope=`launchpad-v1:${new PublicKey(program).toBase58()}:${genesis}`}
 derive(intent,role){if(typeof intent!=='string'||!/^[a-zA-Z0-9_-]{16,128}$/.test(intent)||!['deposit','mint'].includes(role))throw Error('invalid_key_identity');return Keypair.fromSeed(createHmac('sha256',this.#master).update(`${this.#scope}:${intent}:${role}`).digest())}
 activationSeed(intent){this.derive(intent,'mint');return createHmac('sha256',this.#master).update(`${this.#scope}:${intent}:activation`).digest('hex')}
 publicKeys(intent){return {deposit:this.derive(intent,'deposit').publicKey.toBase58(),mint:this.derive(intent,'mint').publicKey.toBase58()}}
}
const instruction=p=>new TransactionInstruction({programId:new PublicKey(p.program),keys:p.accounts.map(a=>({pubkey:new PublicKey(a.address),isWritable:a.writable,isSigner:a.signer})),data:Buffer.from(p.dataBase64,'base64')});
// Only canonical instructions rebuilt from a sealed intent may reach this signer.
// There is no generic signing API or caller-supplied instruction path.
export function transactionBuilder({connection,vault,program,expectedGenesis,loadIntent}){
 return async job=>{
  if(await connection.getGenesisHash()!==expectedGenesis)throw Error('wrong_cluster');
  const body=typeof job.body==='string'?JSON.parse(job.body):job.body;
  const intent=await loadIntent(body.intent);if(!intent||intent.id!==body.intent)throw Error('intent_not_found');
  const deposit=vault.derive(intent.id,'deposit'),mint=vault.derive(intent.id,'mint');
  if(deposit.publicKey.toBase58()!==intent.deposit_address)throw Error('deposit_identity_mismatch');
  const params=typeof intent.params==='string'?JSON.parse(intent.params):intent.params;
  const latest=await connection.getLatestBlockhash('confirmed');let instructions,signers=[deposit];
  if(job.kind==='refund'){
   const destination=new PublicKey(intent.refund_address||intent.owner);
   if(destination.toBase58()!==body.destination)throw Error('refund_destination_mismatch');
   if(typeof body.gross_lamports==='number'&&!Number.isSafeInteger(body.gross_lamports))throw Error('unsafe_amount');
   const gross=integer(typeof body.gross_lamports==='number'?String(body.gross_lamports):body.gross_lamports);
   const probe=new Transaction({feePayer:deposit.publicKey,recentBlockhash:latest.blockhash}).add(SystemProgram.transfer({fromPubkey:deposit.publicKey,toPubkey:destination,lamports:1n}));
   const quote=await connection.getFeeForMessage(probe.compileMessage(),'confirmed');
   if(!Number.isSafeInteger(quote.value)||quote.value<0||gross<=BigInt(quote.value))throw Error('refund_below_network_fee');
   const balance=await connection.getBalance(deposit.publicKey,'finalized');
   if(!Number.isSafeInteger(balance)||BigInt(balance)<gross)throw Error('insufficient_refund_balance');
   instructions=[SystemProgram.transfer({fromPubkey:deposit.publicKey,toPubkey:destination,lamports:gross-BigInt(quote.value)})];
  }else if(job.kind==='cancel_launch'){
   if(intent.state!=='cancelling')throw Error('cancellation_not_requested');
   const address=addresses(program,mint.publicKey).launch,account=await connection.getAccountInfo(address,'finalized');
   const launch=decodeLaunch({account,address,program,mint:mint.publicKey});
   if(launch.cancelled||launch.randomnessReady||launch.graduated||launch.sold!==0n||launch.quote!==0n)throw Error('launch_not_cancellable');
   instructions=[cancelLaunchInstruction({program,mint:mint.publicKey,launcher:deposit.publicKey,ticker:launch.args.ticker})];
  }else if(job.kind==='launch_stage'){
   if(intent.state!=='paid')throw Error('intent_not_paid');
   const plan=planLaunch({program,mint:mint.publicKey,payer:deposit.publicKey,config:{...params.config,beneficiary:intent.owner},blockedWallets:params.blockedWallets??[],activation:{...params.activation,seed:vault.activationSeed(intent.id)}});
   const stages=[...plan.stages,...(plan.developerAllocation?[plan.developerAllocation]:[])];
   if(!Number.isInteger(body.stage)||body.stage<0||body.stage>=stages.length)throw Error('invalid_stage');
   if(body.plan_hash!==hash(Buffer.from(JSON.stringify(plan))))throw Error('plan_commitment_mismatch');
   const stage=stages[body.stage];
   let waiting;
   if(stage.kind==='activate'&&!await activationFulfilled(connection,vault.activationSeed(intent.id),deposit.publicKey))waiting='oracle_fulfillment';
   if(stage.kind==='execute_developer_buy'){
    const address=addresses(program,mint.publicKey).launch,account=await connection.getAccountInfo(address,'finalized');
    const launch=decodeLaunch({account,address,program,mint:mint.publicKey});
    const slot=await connection.getSlot('finalized');
    if(!launch.randomnessReady||BigInt(slot)<launch.startSlot+launch.args.protectionSlots)waiting='protection_window';
   }
   if(waiting){if(!Number.isSafeInteger(intent.expires_at)||Date.now()/1000>intent.expires_at+86400)throw Error('activation_wait_expired');return {deferred:waiting,retryAfter:10}}
   instructions=stages[body.stage].instructions.map(instruction);if(body.stage===0)signers.push(mint);
  }else throw Error('unsupported_job_kind');
  const tx=new Transaction({feePayer:deposit.publicKey,recentBlockhash:latest.blockhash}).add(...instructions);tx.sign(...signers);
  const wire=tx.serialize();if(wire.length>1232)throw Error('transaction_too_large');
  return {wire_transaction:wire.toString('base64'),wire_hash:hash(wire),message_hash:hash(tx.serializeMessage()),signature:base58(tx.signature),last_valid_height:latest.lastValidBlockHeight};
 };
}
export function sealedLaunchPlan({vault,program,intent,config,blockedWallets=[],activation}){
 const keys=vault.publicKeys(intent.id);if(keys.deposit!==intent.deposit_address)throw Error('deposit_identity_mismatch');
 const plan=planLaunch({program,mint:keys.mint,payer:keys.deposit,config:{...config,beneficiary:intent.owner},blockedWallets,activation:{...activation,seed:vault.activationSeed(intent.id)}});
 return {plan,hash:hash(Buffer.from(JSON.stringify(plan))),stageCount:plan.stages.length+(plan.developerAllocation?1:0)};
}
