import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validatePangeaQuote} from '../website/src/onepill-trade.mjs';
import {solanaHistory} from '../website/dist/onepill-market.mjs';
const intent={owner:'CjNLWVWhVAqBjFrp4YWhJb4wLhg5p5ZcfffE1g3eUtsA',mint:'GvQijLpMhfmJkNs33JThb1xsJBRvge8L3hJ4yAm7F6ea',pool:'3VLTJqLiPyedTywVqrnDqcqVfwn61dFucknhgjwS4oA8'};
const buy=JSON.parse(await readFile(new URL('./fixtures/pangea-buy.json',import.meta.url))),sell=JSON.parse(await readFile(new URL('./fixtures/pangea-sell.json',import.meta.url)));
test('real direct Solana buy matches intended pool and amount; unavailable sell is rejected',()=>{assert.equal(validatePangeaQuote(buy,{...intent,side:'buy',amount:'1000000'}).length,8);assert.throws(()=>validatePangeaQuote(sell,{...intent,side:'sell',amount:'1000000000'}))});
test('reject cross-chain, substituted pool, changed amount, missing slippage and added transfer',()=>{for(const change of [q=>q.crossChain=true,q=>q.details.currencyOut.minimumAmount='0',q=>q.steps[0].items[0].data.instructions.push(q.steps[0].items[0].data.instructions[4])]){const q=structuredClone(buy);change(q);assert.throws(()=>validatePangeaQuote(q,{...intent,side:'buy',amount:'1000000'}))}assert.throws(()=>validatePangeaQuote(buy,{...intent,pool:intent.mint,side:'buy',amount:'1000000'}));assert.throws(()=>validatePangeaQuote(buy,{...intent,side:'buy',amount:'2000000'}));});
test('chart and tape exclude all non-Solana trades and candles',()=>{const r=solanaHistory({launches:[{slug:'test',chainCandles:[{chain:'base',candles:[{t:1,c:999}]},{chain:'solana',candles:[{t:2,o:1,h:2,l:1,c:2,v:3}]}],chains:[{chain:'solana',coverage:.5}],recent:[{chain:'base'},{chain:'solana',id:2}]}]},'test');assert.equal(r.bars.length,1);assert.equal(r.bars[0].close,2);assert.equal(r.trades.length,1);assert.equal(r.coverage,.5)});

test('current full-balance Solana sell quote validates exact token input',async()=>{
 const {readFile}=await import('node:fs/promises');const q=JSON.parse(await readFile(new URL('./fixtures/pangea-full-sell.json',import.meta.url),'utf8'));
 const intent={owner:'8urnp7Mp4HbS7iBytqavDSGxWeYUneeUZb4uD2qaoNd9',mint:'GvQijLpMhfmJkNs33JThb1xsJBRvge8L3hJ4yAm7F6ea',pool:'3VLTJqLiPyedTywVqrnDqcqVfwn61dFucknhgjwS4oA8',side:'sell',amount:'1481728722037427'};
 assert.equal(validatePangeaQuote(q,intent).length,6);
 assert.throws(()=>validatePangeaQuote(q,{...intent,amount:'1481728722037428'}));
});
