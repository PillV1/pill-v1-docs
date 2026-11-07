import test from 'node:test';
import assert from 'node:assert/strict';
import {checkBuySlot} from '../sdk/src/launch-protection.mjs';
import {createLaunchInstruction,DEVELOPMENT_PROGRAM} from '../sdk/src/instructions.mjs';
import {Keypair} from '@solana/web3.js';
test('shared slot quotes enforce aggregate cap, exact boundary, next slot and stale clock',()=>{
 const launch={buySlot:10n,slotBought:60n};
 assert.doesNotThrow(()=>checkBuySlot(launch,10n,40n,10000n));
 assert.throws(()=>checkBuySlot(launch,10n,41n,10000n),/buy_slot_limit/);
 assert.doesNotThrow(()=>checkBuySlot(launch,11n,100n,10000n));
 assert.throws(()=>checkBuySlot(launch,11n,101n,10000n),/buy_slot_limit/);
 assert.throws(()=>checkBuySlot(launch,9n,1n,10000n),/invalid_buy_slot/);
 assert.throws(()=>checkBuySlot({},10n,1n,10000n));
});
test('oversized prefunded developer allocations are rejected before signing',()=>{
 const owner=Keypair.generate().publicKey,mint=Keypair.generate().publicKey;
 const config={ticker:'TEST',name:'Coin',uri:'ipfs://test',supply:'1000000000000000',saleTokens:'800000000000000',virtualTokens:'1000000000000000',virtualQuote:'30000000000',targetQuote:'85000000000',maxWalletBps:'400',protectionSlots:'4',feeMode:'burn',blocked:[],developerBuyLamports:'1000000000'};
 assert.throws(()=>createLaunchInstruction({program:DEVELOPMENT_PROGRAM,mint,creator:owner,config}),/developer_buy_slot_limit/);
 assert.doesNotThrow(()=>createLaunchInstruction({program:DEVELOPMENT_PROGRAM,mint,creator:owner,config:{...config,developerBuyLamports:'200000000'}}));
});
