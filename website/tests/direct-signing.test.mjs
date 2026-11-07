import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {Connection,Keypair,PublicKey,Transaction} from '@solana/web3.js';
import {prepareDirectLaunch,advanceDirectLaunch,reconcileDirectLaunch,plan} from '../src/direct-launch.mjs';
import {readFile} from 'node:fs/promises';
// Public, unfunded test fixture. Never use for a real launch.
const testMintSecret=JSON.parse(await readFile(new URL('./fixtures/public-test-mint-piLL.json',import.meta.url),'utf8'));
const vanityOptions={concurrency:1,workerFactory:()=>({postMessage(){queueMicrotask(()=>this.onmessage({data:{secretKey:new Uint8Array(testMintSecret)}}))},terminate(){}})};
import {ORAO} from '../vendor/sdk/activation.mjs';import {base58} from '../src/base58.mjs';
test('wallet signs the real creation plan; persist precedes broadcast and unknown outcomes cannot re-sign',async()=>{
 const payer=Keypair.generate(),program=Keypair.generate().publicKey,treasury=Keypair.generate().publicKey,operator=Keypair.generate().publicKey;
 const config={directLaunchEnabled:true,rpcUrl:'https://rpc.invalid',program:program.toBase58(),genesis:'test-genesis',treasury:treasury.toBase58(),operator:operator.toBase58()};
 const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('config')],program),data=Buffer.concat([createHash('sha256').update('account:Config').digest().subarray(0,8),treasury.toBuffer(),Buffer.from([bump]),operator.toBuffer()]);
 const oracle=Buffer.alloc(84);createHash('sha256').update('account:NetworkState').digest().copy(oracle,0,0,8);treasury.toBuffer().copy(oracle,40);oracle.writeBigUInt64LE(10000n,72);
 const methods=['getGenesisHash','getMultipleAccountsInfoAndContext','getAccountInfo','getLatestBlockhash','sendRawTransaction','confirmTransaction','getSignatureStatuses'];const old=Object.fromEntries(methods.map(k=>[k,Connection.prototype[k]]));
 let persisted=false,signatures=0,status=null,throwSend=true;
 Object.assign(Connection.prototype,{async getGenesisHash(){return 'test-genesis'},async getMultipleAccountsInfoAndContext(){return {context:{slot:100},value:[{executable:true},{owner:program,executable:false,data}]}},async getAccountInfo(){return {owner:ORAO,data:oracle}},async getLatestBlockhash(){return {blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}},async sendRawTransaction(bytes){assert(persisted);assert(Transaction.from(bytes).verifySignatures());if(throwSend)throw Error('timeout');return base58(Transaction.from(bytes).signature)},async confirmTransaction(){return {value:{err:null}}},async getSignatureStatuses(){return {value:[status]}}});
 try{
 const owner=payer.publicKey.toBase58(),payload={owner,blockedWallets:[],config:{ticker:'TEST',name:'Test',uri:'ipfs://published',supply:'1000000000000000',saleTokens:'800000000000000',virtualTokens:'1000000000000000',virtualQuote:'30000000000',targetQuote:'85000000000',maxWalletBps:'250',protectionSlots:'4',feeMode:'burn',beneficiary:owner,blocked:[],developerBuyLamports:'0'}};
 const record=await prepareDirectLaunch(config,payload,owner,vanityOptions),provider={publicKey:payer.publicKey,async signTransaction(tx){signatures++;tx.partialSign(payer);return tx}},persist=r=>{persisted=!!r.pending;assert(!JSON.stringify(r).includes('secretKey'))};
 assert(record.mint.endsWith('piLL'));assert.equal(record.stageCount,3);await advanceDirectLaunch(config,record,provider,persist);assert(record.pending);assert.equal(record.step,0);assert.equal(signatures,1);
 await assert.rejects(advanceDirectLaunch(config,record,provider,persist),/still pending/);assert.equal(signatures,1);
 status={confirmationStatus:'finalized',err:null};await reconcileDirectLaunch(config,record,owner,persist);assert.equal(record.step,1);assert.equal(record.pending,null);assert.equal(record.history[0].state,'finalized');
 }finally{Object.assign(Connection.prototype,old)}
});

test('classic creates only the classic instruction without protection or custom rules',()=>{
 const key=()=>Keypair.generate().publicKey.toBase58();
 const result=plan({program:key(),mint:key(),owner:key(),payload:{version:'v1',config:{name:'Classic',ticker:'OLD',uri:'ipfs://published',feeMode:'burn',maxWalletBps:'50'},blockedWallets:[key()]}});
 assert.equal(result.stages.length,1);assert.equal(result.blockedWalletCount,0);
 const bytes=Buffer.from(result.stages[0].instructions[0].dataBase64,'base64');
 assert.deepEqual(bytes.subarray(0,8),createHash('sha256').update('global:create_classic').digest().subarray(0,8));
});
