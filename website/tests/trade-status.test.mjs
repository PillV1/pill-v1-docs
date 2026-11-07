import test from 'node:test';import assert from 'node:assert/strict';import {reconcileTrade} from '../src/trade-status.mjs';import {supplyPercentage} from '../src/market-format.mjs';
const record={signature:'signature',lastValidBlockHeight:100,blockhash:'blockhash'};
const connection=(status,height=101)=>({getSignatureStatuses:async()=>({value:[status]}),isBlockhashValid:async()=>({value:height<=100}),getBlockHeight:async()=>{throw Error('Must not use block height')}});
test('only finalized success/failure or absent expired signatures unlock pending trades',async()=>{
 assert.equal((await reconcileTrade(connection({confirmationStatus:'finalized',err:null}),record)).state,'finalized');
 assert.equal((await reconcileTrade(connection({confirmationStatus:'finalized',err:{InstructionError:[0,'x']}}),record)).state,'failed');
 assert.equal((await reconcileTrade(connection({confirmationStatus:'confirmed',err:null}),record)).state,'pending');
 assert.equal((await reconcileTrade(connection(null,99),record)).state,'pending');
 assert.equal((await reconcileTrade(connection(null),record)).state,'expired');
});
test('missing record or unavailable RPC never clears an uncertain trade',async()=>{assert.equal((await reconcileTrade(connection(null),{})).state,'unknown');await assert.rejects(reconcileTrade({getSignatureStatuses:async()=>{throw Error('offline')}},record))});
test('held supply percentages use raw units and preserve small balances',()=>{assert.equal(supplyPercentage('3488296484635','1000000000000000'),'0.3488%');assert.equal(supplyPercentage('31000000000000','1000000000000000'),'3.1%');assert.equal(supplyPercentage('1','1000000000000000'),'<0.0001%');assert.equal(supplyPercentage('10',null),'—')});
test('recent confirmed hashes cannot be expired just because finalized bank has not seen them',async()=>{
 const rpc={getSignatureStatuses:async()=>({value:[null]}),isBlockhashValid:async(h,{commitment})=>({value:commitment==='confirmed'})};
 assert.equal((await reconcileTrade(rpc,record)).state,'pending');
});
test('rechecks signature after invalid hash so a finalized landing is not marked expired',async()=>{
 let reads=0;const rpc={getSignatureStatuses:async()=>({value:[++reads===1?null:{confirmationStatus:'finalized',err:null}]}),isBlockhashValid:async()=>({value:false})};
 assert.equal((await reconcileTrade(rpc,record)).state,'finalized');
});
test('confirmation does not depend on broken block-height RPC responses',async()=>{
 const {confirmTrade}=await import('../src/trade-status.mjs');
 let reads=0;const rpc={getSignatureStatuses:async()=>({value:[++reads===1?null:{confirmationStatus:'finalized',err:null}]}),isBlockhashValid:async()=>({value:true}),getBlockHeight:async()=>{throw Error('Unreliable endpoint must not be called')}};
 assert.equal(await confirmTrade(rpc,record,{timeoutMs:100,pollMs:1}),record.signature);
});
