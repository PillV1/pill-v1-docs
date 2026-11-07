import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Keypair,PublicKey} from '@solana/web3.js';
import {addresses,DEVELOPMENT_PROGRAM,u64,createLaunchInstruction} from '../sdk/src/instructions.mjs';
import {decodeLaunch,decodePosition,jsonAccount} from '../sdk/src/accounts.mjs';
import {prepareTrade} from '../sdk/src/read-client.mjs';
const program=DEVELOPMENT_PROGRAM,mint=Keypair.generate().publicKey,owner=Keypair.generate().publicKey;
const a=addresses(program,mint,owner),zero=new PublicKey('11111111111111111111111111111111');
const args={ticker:'TEST',name:'Coin',uri:'https://example.com/token.json',supply:'1000000000000000',saleTokens:'800000000000000',virtualTokens:'1000000000000000',virtualQuote:'30000000000',targetQuote:'85000000000',maxWalletBps:'400',protectionSlots:'4',feeMode:'holders',blocked:[]};
const tag=name=>createHash('sha256').update(`account:${name}`).digest().subarray(0,8);
function launchAccount(){return {owner:program,executable:false,data:Buffer.concat([
 tag('Launch'),owner.toBuffer(),owner.toBuffer(),mint.toBuffer(),owner.toBuffer(),zero.toBuffer(),Buffer.from([255]),
 createLaunchInstruction({program,mint,creator:owner,config:args}).data.subarray(8),
 u64('100'),u64('1000'),u64('0'),u64('0'),u64('0'),u64('0'),Buffer.from([0]),u64('0'),u64('0'),Buffer.alloc(16),u64('0'),Buffer.alloc(2),u64('0'),u64('0'),u64('0'),Buffer.from([1]),Buffer.alloc(32),Buffer.from([0,1]),Buffer.alloc(26)
 ])}}
function positionAccount(){return {owner:program,executable:false,data:Buffer.concat([tag('Position'),owner.toBuffer(),a.launch.toBuffer(),u64('9007199254740993'),u64('0'),u64('0'),Buffer.alloc(16),Buffer.alloc(16),u64('1')])}}
test('account reader retains exact large balances and rejects substituted ownership and PDA',()=>{
 const account=positionAccount(),input={account,address:a.position,program,mint,owner};
 assert.equal(decodePosition(input).balance,9007199254740993n);assert.equal(jsonAccount(decodePosition(input)).balance,'9007199254740993');
 assert.throws(()=>decodePosition({...input,address:owner}),/position_address/);
 assert.throws(()=>decodePosition({...input,account:{...account,owner:zero}}),/owner_mismatch/);
 assert.equal(decodePosition({...input,account:null}).balance,0n);
 assert.throws(()=>decodePosition({...input,account:undefined}),/owner_mismatch/);
});
test('launch decoder handles variable fields and rejects truncated, unknown and wrong versions',()=>{
 const account=launchAccount(),input={account,address:a.launch,program,mint};
 const l=decodeLaunch(input);assert.equal(l.args.ticker,'TEST');assert.equal(l.args.virtualQuote,30000000000n);assert.equal(l.developerExecuted,true);
 assert.throws(()=>decodeLaunch({...input,mint:owner}),/identity_mismatch/);
 assert.throws(()=>decodeLaunch({...input,account:{...account,data:account.data.subarray(0,50)}}),/truncated/);
 assert.throws(()=>decodeLaunch({...input,account:{...account,data:Buffer.concat([account.data,Buffer.from([1])])}}),/unknown_account_version/);
 const bad=Buffer.from(account.data);bad[0]^=1;assert.throws(()=>decodeLaunch({...input,account:{...account,data:bad}}),/discriminator/);
});
test('trade client binds all inputs to one chain bank and returns an unsigned bounded instruction',async()=>{
 const data=Buffer.alloc(40);data.writeBigUInt64LE(104n);data.writeBigInt64LE(1000n,32);
 const snapshot={context:{slot:104},value:[launchAccount(),null,null,{owner:new PublicKey('Sysvar1111111111111111111111111111111111111'),data}]};
 let calls=0;
 const connection={getGenesisHash:async()=>'test-genesis',getMultipleAccountsInfoAndContext:async(keys,options)=>{calls++;assert.equal(keys.length,4);assert.equal(options.commitment,'confirmed');return snapshot}};
 const input={connection,program,mint,trader:owner,expectedGenesis:'test-genesis',side:'buy',amount:'1000000'};
 const result=await prepareTrade(input);assert.equal(calls,1);assert.equal(result.instruction.data.readBigUInt64LE(16),result.quote.minimumOutput);assert.equal(result.quote.deadlineSlot,254n);
 await assert.rejects(()=>prepareTrade({...input,expectedGenesis:'other'}),/wrong_cluster/);
 snapshot.context.slot=105;await assert.rejects(()=>prepareTrade(input),/inconsistent_rpc_clock/);
 snapshot.context.slot=104;snapshot.value[2]={owner:program};await assert.rejects(()=>prepareTrade(input),/wallet_blocked/);
});

test('integration co-signature leaves wallet authorization required and ignores caller transaction bytes',async()=>{
 const {Trading}=await import('../services/api/trading.mjs');const {Transaction}=await import('@solana/web3.js');
 const clock=Buffer.alloc(40);clock.writeBigUInt64LE(104n);clock.writeBigInt64LE(1000n,32);
 const appSigner=Keypair.generate(),connection={getGenesisHash:async()=>'test',getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:500}),getMultipleAccountsInfoAndContext:async()=>({context:{slot:104},value:[launchAccount(),null,null,{owner:new PublicKey('Sysvar1111111111111111111111111111111111111'),data:clock}]})};
 const service=new Trading({identity:{session:token=>{if(token!=='session')throw Error('unauthenticated');return {wallet:owner.toBase58()}}},connection,program,genesis:'test',appSigner});
 const result=await service.prepare('session',{mint:mint.toBase58(),side:'buy',amount:'1000000',transaction:'malicious arbitrary bytes'},1000),tx=Transaction.from(Buffer.from(result.transaction,'base64'));
 assert.equal(result.slot,104);assert.equal(tx.instructions.length,1);assert(tx.instructions[0].programId.equals(program));assert(tx.feePayer.equals(owner));assert.equal(tx.signatures.find(s=>s.publicKey.equals(owner)).signature,null);assert(tx.signatures.find(s=>s.publicKey.equals(appSigner.publicKey)).signature);assert(tx.verifySignatures(false));
 await assert.rejects(()=>service.prepare('wrong',{mint:mint.toBase58()},1000),/unauthenticated/);
});
