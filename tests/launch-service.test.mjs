import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {randomBytes,createHash} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {Keypair} from '@solana/web3.js';
import {LaunchService} from '../services/api/launch-service.mjs';import {SignerVault} from '../services/api/signing.mjs';import {DEVELOPMENT_PROGRAM,u64} from '../sdk/src/instructions.mjs';import {ORAO} from '../sdk/src/activation.mjs';
const config={ticker:'TEST',name:'Coin',uri:'ipfs://metadata',supply:'1000000000000000',saleTokens:'800000000000000',virtualTokens:'1000000000000000',virtualQuote:'30000000000',targetQuote:'85000000000',maxWalletBps:'400',protectionSlots:'4',feeMode:'burn',blocked:[]};
test('launch API seals owner, oracle cost and activation stages; status is secret-bound',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'launch-api-')),path=join(dir,'backend.db');let db;
 try{
  const script=fileURLToPath(new URL('../scripts/init_backend.py',import.meta.url));execFileSync('python3',[script,'--database',path]);db=new DatabaseSync(path);
  const owner=Keypair.generate().publicKey.toBase58(),oracle=Keypair.generate().publicKey,genesis='test',program=DEVELOPMENT_PROGRAM,vault=new SignerVault(randomBytes(32),{program,genesis});
  const oracleData=Buffer.concat([createHash('sha256').update('account:NetworkState').digest().subarray(0,8),oracle.toBuffer(),oracle.toBuffer(),u64('123456'),Buffer.alloc(5),u64('0')]);
  const connection={getGenesisHash:async()=>genesis,getAccountInfo:async()=>({owner:ORAO,data:oracleData}),getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58()}),getFeeForMessage:async message=>({value:message.header.numRequiredSignatures*5000}),getMinimumBalanceForRentExemption:async()=>100000};
  const service=new LaunchService({db,vault,program,connection,expectedGenesis:genesis,enabled:true});
  const input={owner,requestId:'request_123456789012345678901234567890',config};
  const result=await service.create(input,1000);assert.equal(result.transactionCount,3);assert.equal(result.expectedLamports,'50143456');
  const row=db.prepare('SELECT * FROM intents').get(),params=JSON.parse(row.params);assert.equal(params.config.beneficiary,owner);assert.equal(params.activation.maxFee,'123456');assert.equal(row.refund_address,owner);assert.equal(row.accept_any_sender,1);
  assert.equal(service.status(result.id,result.statusToken).state,'awaiting_payment');assert.throws(()=>service.status(result.id,'other'),/intent_not_found/);
  await assert.rejects(()=>service.create(input,1001),/request_already_created/);assert.equal(db.prepare('SELECT count(*) n FROM intents').get().n,1);
  service.enabled=false;await assert.rejects(()=>service.create(input,1002),/disabled/);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true})}
});
