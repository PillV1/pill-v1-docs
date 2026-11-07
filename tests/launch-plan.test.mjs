import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {planLaunch} from '../sdk/src/launch-plan.mjs';
import {DEVELOPMENT_PROGRAM,createLaunchInstruction} from '../sdk/src/instructions.mjs';
const payer=Keypair.generate().publicKey,mint=Keypair.generate().publicKey;
const config={ticker:'TEST',name:'Coin',uri:'https://example.com/token.json',supply:'1000000000000000',saleTokens:'800000000000000',virtualTokens:'1000000000000000',virtualQuote:'30000000000',targetQuote:'85000000000',maxWalletBps:'400',protectionSlots:'4',feeMode:'burn',blocked:[]};
const input={program:DEVELOPMENT_PROGRAM,mint,payer,config,activation:{seed:'42'.repeat(32),oracleTreasury:payer,maxFee:'10000'}};
test('full catalogue becomes bounded deterministic transactions with sealed final count',()=>{
 const wallets=Array.from({length:929},()=>Keypair.generate().publicKey.toBase58());
 const plan=planLaunch({...input,blockedWallets:wallets});
 assert.equal(plan.blockedWalletCount,929);assert.equal(plan.blockedPdaCount,921);assert.equal(plan.stages.length,234);
 assert(plan.stages.every(s=>s.estimatedWireBytes<=1232));assert.equal(plan.stages[0].kind,'create_launch');
 const creation=Buffer.from(plan.stages[0].instructions[0].dataBase64,'base64');assert.equal(creation.readUInt16LE(79+8*32),921);
 assert.deepEqual(plan,planLaunch({...input,blockedWallets:[...wallets].reverse().concat(wallets[0])}));
});
test('initial developer purchase waits after activation and cannot target a blocked beneficiary',()=>{
 const plan=planLaunch({...input,config:{...config,developerBuyLamports:'200000000'}});assert.equal(plan.developerAllocation.kind,'execute_developer_buy');assert.equal(plan.readyForBroadcast,false);
 assert.throws(()=>planLaunch({...input,config:{...config,developerBuyLamports:'200000000'},blockedWallets:[payer]}),/developer_is_blocked/);
 assert.throws(()=>planLaunch({...input,config:{...config,extraBlockedCount:2}}),/planner_owns/);
});
test('creation rejects unsupported modes, ambiguous booleans and unusable developer budgets',()=>{
 for(const patch of [{feeMode:'toString'},{feeMode:'unknown'},{quickBond:'false'},{transfersOpen:1},{developerBuyLamports:'1'},{developerBuyLamports:'100000000000'}])assert.throws(()=>createLaunchInstruction({program:input.program,mint,creator:payer,config:{...config,...patch}}));
});

test('automatic launch combines creation and randomness request without changing legacy saved plans',()=>{
 const automatic=planLaunch({...input,automatic:true});
 assert.equal(automatic.stages[0].instructions.length,2);
 assert.equal(automatic.stages[1].kind,'activate');
 assert(automatic.stages.every(s=>s.estimatedWireBytes<=1232));
 assert.equal(planLaunch(input).stages[1].kind,'request_activation');
});
