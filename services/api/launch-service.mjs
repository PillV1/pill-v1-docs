import {randomBytes,createHash} from 'node:crypto';
import {PublicKey,Transaction,TransactionInstruction} from '@solana/web3.js';
import {sealedLaunchPlan} from './signing.mjs';
import {readOracleConfig} from '../../sdk/src/activation.mjs';
import {integer} from '../../sdk/src/quotes.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v}
export class LaunchService {
 constructor({db,vault,program,connection,expectedGenesis,enabled=false}){
  Object.assign(this,{db,vault,program,connection,expectedGenesis,enabled});
  db.exec('CREATE TABLE IF NOT EXISTS intent_access(intent TEXT PRIMARY KEY,token_hash TEXT NOT NULL);');
 }
 async create({owner,requestId,config,blockedWallets=[],refundAddress},now){
  if(!this.enabled)throw Error('launch_payments_disabled');
  if(await this.connection.getGenesisHash()!==this.expectedGenesis)throw Error('wrong_cluster');
  owner=new PublicKey(owner).toBase58();refundAddress=new PublicKey(refundAddress??owner).toBase58();
  if(typeof requestId!=='string'||! /^[a-zA-Z0-9_-]{32,128}$/.test(requestId))throw Error('invalid_request_id');
  const activation=await readOracleConfig(this.connection);
  const params=canonical({activation,config:{...config,beneficiary:owner},blockedWallets});const encoded=JSON.stringify(params),paramsHash=hash(encoded);
  if(Buffer.byteLength(encoded)>600000)throw Error('intent_too_large');
  if(this.db.prepare('SELECT id FROM intents WHERE owner=? AND request_id=?').get(owner,requestId))throw Error('request_already_created');
  const id=randomBytes(24).toString('hex'),access=randomBytes(32).toString('base64url'),keys=this.vault.publicKeys(id);
  const intent={id,owner,deposit_address:keys.deposit},sealed=sealedLaunchPlan({vault:this.vault,program:this.program,intent,config:params.config,blockedWallets,activation});
  const latest=await this.connection.getLatestBlockhash('confirmed');let fees=0n;const feeCache=new Map();
  const stages=[...sealed.plan.stages,...(sealed.plan.developerAllocation?[sealed.plan.developerAllocation]:[])];
  for(const stage of stages){
   // Signature count determines the base fee; still ask the RPC for each stage shape.
   const shape=stage.kind+':'+stage.instructions.length;
   if(!feeCache.has(shape)){
    const tx=new Transaction({feePayer:new PublicKey(keys.deposit),recentBlockhash:latest.blockhash});
    for(const i of stage.instructions)tx.add(new TransactionInstruction({programId:new PublicKey(i.program),keys:i.accounts.map(a=>({pubkey:new PublicKey(a.address),isSigner:a.signer,isWritable:a.writable})),data:Buffer.from(i.dataBase64,'base64')}));
    const result=await this.connection.getFeeForMessage(tx.compileMessage(),'confirmed');if(!Number.isSafeInteger(result.value)||result.value<0)throw Error('network_fee_unavailable');feeCache.set(shape,BigInt(result.value));
   }
   fees+=feeCache.get(shape);
  }
  const blockRent=await this.connection.getMinimumBalanceForRentExemption(72,'confirmed');if(!Number.isSafeInteger(blockRent)||blockRent<0)throw Error('rent_unavailable');
  // Refundable creation reserve, not an undisclosed service fee. Exact unused
  // funds are reconciled from finalized transaction debits by Workflows.
  const reserve=50_000_000n,developer=integer(config.developerBuyLamports??'0');
  const expected=reserve+developer+fees+integer(activation.maxFee)+BigInt(blockRent)*BigInt(sealed.plan.blockedPdaCount);
  if(expected>9_000_000_000_000_000n)throw Error('intent_amount_too_large');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare("INSERT INTO intents(id,owner,request_id,deposit_address,expected,expires_at,params_hash,params,accept_any_sender,refund_address) VALUES(?,?,?,?,?,?,?,?,1,?)").run(id,owner,requestId,keys.deposit,Number(expected),now+900,paramsHash,encoded,refundAddress);
   this.db.prepare('INSERT INTO intent_access VALUES(?,?)').run(id,hash(access));
   this.db.prepare('INSERT INTO launch_plans VALUES(?,?,?,?)').run(id,sealed.hash,sealed.stageCount,keys.mint);
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e}
  return {id,statusToken:access,depositAddress:keys.deposit,mint:keys.mint,expectedLamports:expected.toString(),expiresAt:now+900,transactionCount:sealed.stageCount,refundableCreationReserveLamports:reserve.toString(),networkFeeEstimateLamports:fees.toString()};
 }
 status(id,access){
  if(typeof access!=='string'||access.length>128)throw Error('invalid_status_token');
  const row=this.db.prepare('SELECT i.id,i.state,i.expected,i.received,i.expires_at,p.mint FROM intents i JOIN intent_access a ON a.intent=i.id JOIN launch_plans p ON p.intent=i.id WHERE i.id=? AND a.token_hash=?').get(id,hash(access));
  if(!row)throw Error('intent_not_found');
  const jobs=this.db.prepare('SELECT kind,phase,signature FROM jobs WHERE launch=? ORDER BY id').all(id);
  return {...row,expected:String(row.expected),received:String(row.received),jobs};
 }
}
