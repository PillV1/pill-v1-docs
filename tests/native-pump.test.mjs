import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {Keypair,PublicKey,Connection,Transaction,ComputeBudgetProgram} from '@solana/web3.js';
import {PUMP_SDK,PUMP_PROGRAM_ID,holderRewardsPda,newBondingCurve,getPumpProgram} from '@pump-fun/pump-sdk';
import {buildNativeCreate} from '../website/src/native-pump.mjs';import {NativePump,nativeEvents,verifyNativeCreate} from '../services/api/native-pump.mjs';
const config=JSON.parse(readFileSync(new URL('../artifacts/verification/native-pump-config.json',import.meta.url)));const global=PUMP_SDK.decodeGlobal({data:Buffer.from(config.global,'base64')}),feeConfig=PUMP_SDK.decodeFeeConfig({data:Buffer.from(config.feeConfig,'base64')});
const sim=readFileSync(new URL('../artifacts/verification/native-pump-simulation.log',import.meta.url),'utf8').trim().split('\n').map(JSON.parse),mint=Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(new URL('../website/tests/fixtures/public-test-mint-piLL.json',import.meta.url))))),owner='CjNLWVWhVAqBjFrp4YWhJb4wLhg5p5ZcfffE1g3eUtsA';
const txFor=row=>({slot:123,blockTime:1700000000,meta:{err:null,logMessages:row.logs},transaction:{message:{getAccountKeys(){return {get(){return null}}}}}});
test('real Pump simulation covers creation, initial buy, and selling with no errors',()=>{assert.equal(sim.length,3);for(const row of sim){assert.equal(row.error,null);assert(row.units>0);assert(row.wireBytes<=1232)}const events=nativeEvents(txFor(sim[2]));assert.equal(events.filter(e=>e.kind==='create').length,1);assert.deepEqual(events.filter(e=>e.kind==='trade').map(e=>e.data.isBuy),[true,false]);verifyNativeCreate(events[0],mint.publicKey.toBase58(),owner)});
test('native creation encodes holder rewards, never cashback, and refuses disabled mode',async()=>{
 const ix=await buildNativeCreate({global,feeConfig,mint:mint.publicKey,owner,config:{name:'Test',ticker:'T',uri:'https://x.co',developerBuyLamports:'0'}});const decoded=getPumpProgram(new Connection('https://rpc.invalid')).coder.instruction.decode(ix[0].data);assert.equal(decoded.data.isHolderReward[0],true);assert.equal(decoded.data.isCashbackEnabled[0],false);assert(ix[0].programId.equals(PUMP_PROGRAM_ID));
 await assert.rejects(buildNativeCreate({global:{...global,isHolderRewardEnabled:false},feeConfig,mint:mint.publicKey,owner,config:{developerBuyLamports:'0'}}),/disabled/);
});
test('failed transactions and logs from another program cannot inject native launches',()=>{
 const tx=txFor(sim[0]);tx.meta.err={InstructionError:[0,'x']};assert.deepEqual(nativeEvents(tx),[]);tx.meta.err=null;tx.meta.logMessages=tx.meta.logMessages.map(s=>s.replaceAll(PUMP_PROGRAM_ID.toBase58(),PublicKey.default.toBase58()));assert.deepEqual(nativeEvents(tx),[]);
 const event=nativeEvents(txFor(sim[0]))[0];assert.throws(()=>verifyNativeCreate(event,mint.publicKey.toBase58(),Keypair.generate().publicKey.toBase58()));assert.throws(()=>verifyNativeCreate({...event,data:{...event.data,isHolderReward:false}},mint.publicKey.toBase58(),owner));
});
test('finalized native registration is authenticated, idempotent, and feeds trades/crowns',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-pump-')),file=join(dir,'index.db');execFileSync('python3',['scripts/init_backend.py','--database',file],{cwd:new URL('..',import.meta.url)});const db=new DatabaseSync(file);
 const curve=newBondingCurve(global);curve.creator=holderRewardsPda(mint.publicKey);curve.isHolderReward=true;const bytes=await getPumpProgram(new Connection('https://rpc.invalid')).coder.accounts.encode('bondingCurve',curve),tx=txFor(sim[2]);
 const service=new NativePump({db,identity:{session(token){if(token!=='valid')throw Error('unauthenticated');return {wallet:owner}}},connection:{_rpcRequest:async()=>({result:{...tx,transaction:{signatures:['2'.repeat(88)],message:{accountKeys:[]}}}}),getAccountInfo:async()=>({owner:PUMP_PROGRAM_ID,data:bytes})}}),input={mint:mint.publicKey.toBase58(),signature:'2'.repeat(88)};
 await assert.rejects(service.register('wrong',input,0),/unauthenticated/);const [registered,concurrent]=await Promise.all([service.register('valid',input,0),service.register('valid',input,0)]);assert.equal(concurrent.launch,registered.launch);assert.equal(registered.mint,input.mint);await service.register('valid',input,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM coins').get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM coin_activity WHERE kind='TradeRecorded'").get().n,2);
 const events=nativeEvents(tx);service.ingest(input.mint,input.signature,tx,events);assert.equal(db.prepare("SELECT COUNT(*) n FROM coin_activity WHERE kind='TradeRecorded'").get().n,2);
 const crossed={...events.find(e=>e.kind==='trade'),data:{...events.find(e=>e.kind==='trade').data,realTokenReserves:global.initialRealTokenReserves.muln(10).divn(100)}};service.ingest(input.mint,'3'.repeat(88),{...tx,slot:124},[crossed]);assert.equal(db.prepare('SELECT crowned_slot FROM crown_progress').get().crowned_slot,124);assert.equal(db.prepare('SELECT crowned_at FROM native_pump').get().crowned_at,tx.blockTime);const rules=await service.rules(input.mint);assert.equal(rules.commitment,'finalized');assert.equal(rules.curve.progressBps,0);assert.equal(rules.curve.reserveLamports,curve.realQuoteReserves.toString());assert.ok(BigInt(rules.curve.estimatedGraduationMarketCapLamports)>0n);db.prepare("UPDATE coins SET phase='pumpswap'").run();assert.equal((await service.rules(input.mint)).graduated,true);db.close();
});

test('external version-1 bot swaps drain the native queue and update trade/chart source data',async()=>{
 const response=JSON.parse(readFileSync(new URL('../artifacts/verification/native-pump-external-v1.json',import.meta.url))),tx=response.result;
 assert.equal(tx.version,1);const signature=tx.transaction.signatures[0],events=nativeEvents(tx),trade=events.find(e=>e.kind==='trade');assert(trade,'external routed swap must decode');
 const mint=trade.data.mint.toBase58(),launch=(await import('@pump-fun/pump-sdk')).bondingCurvePda(trade.data.mint).toBase58();
 const dir=mkdtempSync(join(tmpdir(),'native-external-')),file=join(dir,'index.db');execFileSync('python3',['scripts/init_backend.py','--database',file],{cwd:new URL('..',import.meta.url)});const db=new DatabaseSync(file);
 const requests=[];const service=new NativePump({db,identity:{},connection:{
  _rpcRequest:async(method,params)=>{requests.push({method,params});return response},
  getSignaturesForAddress:async()=>[{signature,slot:tx.slot,err:null}],getAccountInfo:async()=>null,
 }});
 db.prepare("INSERT INTO coins(launch,mint,creator,treasury,created_slot,last_slot,version) VALUES(?,?,?,?,?,?,2)").run(launch,mint,owner,owner,tx.slot-1,tx.slot-1);
 db.prepare('INSERT INTO crown_progress(launch,sale_tokens,sold,supply,virtual_tokens,virtual_quote) VALUES(?,?,?,?,?,?)').run(launch,793100000000000n,0,1000000000000000n,1073000000000000n,30000000000n);
 db.prepare('INSERT INTO native_pump(mint,launch,signature,creator,initial_sale,initial_virtual_tokens,initial_virtual_quote,supply,created,head) VALUES(?,?,?,?,?,?,?,?,?,?)').run(mint,launch,'creation',owner,'793100000000000','1073000000000000','30000000000','1000000000000000',tx.blockTime-1,'creation');
 await service.poll();
 const indexed=db.prepare("SELECT * FROM coin_activity WHERE kind='TradeRecorded'").all();assert.equal(indexed.length,events.filter(e=>e.kind==='trade'&&e.data.mint.toBase58()===mint).length);assert(indexed.length>0);
 assert.equal(db.prepare('SELECT time FROM transaction_times WHERE signature=?').get(signature).time,tx.blockTime);
 assert.equal(db.prepare('SELECT last_slot FROM coins').get().last_slot,tx.slot);
 assert.equal(db.prepare('SELECT count(*) n FROM native_pump_pending').get().n,0);
 assert.equal(db.prepare('SELECT head,last_error FROM native_pump').get().head,signature);
 assert.equal(db.prepare('SELECT last_error FROM native_pump').get().last_error,null);
 assert.equal(requests[0].params[1].maxSupportedTransactionVersion,1);
 await service.poll();assert.equal(db.prepare("SELECT count(*) n FROM coin_activity WHERE kind='TradeRecorded'").get().n,indexed.length);
 db.close();
});
