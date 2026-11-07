import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {quoteTrade,validateCurve} from '../sdk/src/quotes.mjs';
import {u64} from '../sdk/src/instructions.mjs';
const args={supply:1000000000000000n,saleTokens:800000000000000n,virtualTokens:1000000000000000n,virtualQuote:30000000000n,targetQuote:85000000000n,maxWalletBps:400n,protectionSlots:4n,extraBlockedCount:0,blocked:[],quickBond:false};
const launch={args,startSlot:100n,createdAt:1000n,sold:0n,quote:0n,sequence:0n,graduated:false,blockedUploaded:0,developerExecuted:true,randomnessReady:true};
const position={owner:'trader',balance:0n,locked:0n,unlockAt:0n};
const input={launch,position,trader:'trader',blocked:false,side:'buy',amount:'1000000',slot:'104',unixTime:'1000'};
test('quotes match Rust integer math across both tax windows and round trips',()=>{
 const rows=readFileSync(new URL('../artifacts/verification/quote-vectors.csv',import.meta.url),'utf8').trim().split('\n').slice(1);
 assert.equal(rows.length,16);
 for(const row of rows){
  const [slot,amount,tokens,net,fee,sellNet,sellFee]=row.split(',').map(BigInt);
  const buy=quoteTrade({...input,slot,amount});assert.equal(buy.tokens,tokens);assert.equal(buy.netLamports,net);assert.equal(buy.feeLamports,fee);
  const sell=quoteTrade({...input,slot,side:'sell',amount:tokens,launch:{...launch,sold:tokens,quote:net},position:{...position,balance:tokens}});
  assert.equal(sell.netLamports,sellNet);assert.equal(sell.feeLamports,sellFee);
  assert.equal(buy.treasuryFeeLamports+buy.coinFeeLamports+buy.sniperBurnLamports,fee);
  assert.equal(buy.treasuryFeeLamports,(amount*220n+9999n)/10000n);
  assert.equal(sell.treasuryFeeLamports,(sell.grossLamports*220n+9999n)/10000n);
 }
});
test('quotes enforce blocklist activation, cap, developer priority, and reserved capacity',()=>{
 assert.throws(()=>quoteTrade({...input,blocked:undefined}),/block_status/);
 assert.throws(()=>quoteTrade({...input,blocked:true}),/wallet_blocked/);
 assert.throws(()=>quoteTrade({...input,launch:{...launch,args:{...args,extraBlockedCount:1}}}),/not_activated/);
 assert.throws(()=>quoteTrade({...input,position:{...position,balance:40000000000000n}}),/wallet_cap/);
 assert.throws(()=>quoteTrade({...input,launch:{...launch,developerExecuted:false,developerBudget:1000n}}),/developer_allocation_pending/);
 assert.throws(()=>quoteTrade({...input,slot:100n,amount:500000000n,launch:{...launch,quote:84999000000n,developerExecuted:false,developerBudget:1000000n}}),/insufficient_reserves/);
});
test('quotes enforce Quick Bond and developer locks without blocking unlocked sales',()=>{
 const buy=quoteTrade(input),sell={...input,side:'sell',amount:buy.tokens,launch:{...launch,sold:buy.tokens,quote:buy.netLamports},position:{...position,balance:buy.tokens,locked:buy.tokens,unlockAt:4600n}};
 assert.throws(()=>quoteTrade(sell),/developer_tokens_locked/);
 assert.doesNotThrow(()=>quoteTrade({...sell,unixTime:4600n}));
 const quick={...sell,position:{...sell.position,locked:0n},launch:{...sell.launch,args:{...args,quickBond:true}}};
 assert.throws(()=>quoteTrade(quick),/quick_bond_sell_locked/);assert.doesNotThrow(()=>quoteTrade({...quick,unixTime:4600n}));
});
test('quote expiry and slippage are bounded and all amount inputs are exact',()=>{
 const q=quoteTrade(input);assert.equal(q.deadlineSlot,254n);assert.equal(q.minimumOutput,q.expectedOutput*99n/100n);
 for(const amount of [1,1.5,true,'','1e9',' 1','01','-1','0x10'])assert.throws(()=>u64(amount));
 for(const slippageBps of [-1,5001,1.5])assert.throws(()=>quoteTrade({...input,slippageBps}));
 assert.throws(()=>quoteTrade({...input,deadlineSlots:151}));
 assert.throws(()=>validateCurve({...args,targetQuote:120000000000n}));
 assert.throws(()=>quoteTrade({...input,launch:{...launch,graduated:true}}),/curve_closed/);
});

test('launch cannot set a graduation target that cannot fund setup',()=>{
 for(const targetQuote of [0n,1n,49999999n,50000000n])assert.throws(()=>validateCurve({...args,targetQuote}),/invalid_curve_config/);
});
