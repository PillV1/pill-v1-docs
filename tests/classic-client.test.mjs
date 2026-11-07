import test from 'node:test';import assert from 'node:assert/strict';
import {quoteClassicBudget} from '../sdk/src/classic-client.mjs';
import {quoteClassic,CLASSIC} from '../sdk/src/classic.mjs';
const launch={sold:0n,quote:0n,graduated:false};
test('classic SOL budget is capped including slippage and fees',()=>{
 for(const amount of ['100','1000000','1000000000','85000000000'])for(const slippageBps of [0,100,5000]){
 const q=quoteClassicBudget({launch,side:'buy',amount,slippageBps,slot:100n});
 assert(q.walletLamports<=BigInt(amount));assert.equal(q.limit,BigInt(amount));assert.equal(q.deadlineSlot,250n);
 const budget=BigInt(amount)*10000n/(10000n+BigInt(slippageBps));assert(q.walletLamports<=budget);
 if(q.tokens<CLASSIC.saleTokens)assert(quoteClassic({...launch,side:'buy',tokens:q.tokens+1n}).walletLamports>budget);
 }
});
test('classic sells quote token input and bounded SOL output',()=>{
 const buy=quoteClassicBudget({launch,side:'buy',amount:'1000000000',slot:100n});
 const q=quoteClassicBudget({launch:{sold:buy.tokens,quote:buy.principal},side:'sell',amount:buy.tokens,slippageBps:100,slot:101n});
 assert.equal(q.minimumOutput,q.walletLamports*9900n/10000n);assert(q.walletLamports<buy.walletLamports);
 for(const patch of [{side:'invalid'},{amount:'0'},{slippageBps:5001},{launch:{...launch,graduated:true}}])assert.throws(()=>quoteClassicBudget({launch,side:'buy',amount:'1000000',slot:1n,...patch}));
});
