import test from 'node:test';import assert from 'node:assert/strict';
import {decimalUnits,formatUnits,createApi,launchPayload,safeText} from '../src/api.mjs';
import {base58} from '../src/base58.mjs';
const draft={version:'v1.1',name:'Test',ticker:'TEST',uri:'ipfs://published',wallet:'owner',devBuy:'0',cap:'2.5',feeMode:'burn',mode:'standard',appMode:'any',blocked:''};
const options={requestId:'a'.repeat(32),curve:{supply:'1000000000000000'},validateAddress:v=>{if(!v)throw Error('invalid address');return v}};
test('SOL amounts remain exact above Number precision',()=>{assert.equal(decimalUnits('9000000.123456789'),'9000000123456789');assert.equal(formatUnits('9000000123456789',9,9),'9,000,000.123456789')});
test('rejects signs, exponents and excess decimal places',()=>{for(const value of ['-1','1e5','NaN','0.0000000001',''])assert.throws(()=>decimalUnits(value))});
test('zero developer buy remains zero and caps use basis points',()=>{const p=launchPayload(draft,options);assert.equal(p.config.developerBuyLamports,'0');assert.equal(p.config.maxWalletBps,'250');assert.equal(p.refundAddress,'owner')});
test('limits cap and validates metadata protocol and ticker',()=>{for(const patch of [{cap:'0.4'},{cap:'4.5'},{uri:'javascript:alert(1)'},{ticker:'bad-symbol'}])assert.throws(()=>launchPayload({...draft,...patch},options))});
test('deduplicates wallet blocks and commits quick bond',()=>{const p=launchPayload({...draft,blocked:'one\none, two',mode:'quick'},options);assert.deepEqual(p.blockedWallets,['one','two']);assert.equal(p.config.quickBond,true);assert.equal(p.config.transfersOpen,false)});
test('removed app restrictions cannot survive saved drafts',()=>{for(const appMode of ['only','exclude']){const p=launchPayload({...draft,appMode,apps:'invalid old authority',blocked:'wallet'},options);assert.equal(p.config.appMode,'any');assert.deepEqual(p.config.appAuthorities,[]);assert.deepEqual(p.blockedWallets,['wallet']);}});
test('plain text remains text at the HTML boundary',()=>assert.equal(safeText('<img src=x onerror="alert(1)">'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
test('status bearer token never appears in URLs and credentials stay same-origin',async()=>{let seen;const api=createApi({fetcher:async(url,options)=>{seen={url,options};return {ok:true,json:async()=>({state:'pending'})}}});await api.intent('a'.repeat(48),'private-status-token');assert(!seen.url.includes('private-status-token'));assert.equal(seen.options.headers.Authorization,'Bearer private-status-token');assert.equal(seen.options.credentials,'same-origin')});
test('read operations do not mutate, trade preparation sends canonical JSON',async()=>{const calls=[];const api=createApi({fetcher:async(url,options)=>{calls.push({url,...options});return {ok:true,json:async()=>({})}}});await api.coins('opaque/a');await api.prepare({mint:'mint',side:'buy',amount:'123456789'});assert.equal(calls[0].method,'GET');assert.equal(calls[0].url,'/api/coins?limit=100&cursor=opaque%2Fa');assert.equal(calls[1].method,'POST');assert.equal(JSON.parse(calls[1].body).amount,'123456789')});
test('rejects cross-origin API bases and preserves service errors',async()=>{assert.throws(()=>createApi({base:'https://untrusted.example'}));assert.throws(()=>createApi({base:'//untrusted.example'}));const api=createApi({fetcher:async()=>({ok:false,status:503,json:async()=>({error:'launch_payments_disabled'})})});await assert.rejects(api.createIntent({}),/launch_payments_disabled/)});
test('signature base58 encoding matches known vectors',()=>{assert.equal(base58(new Uint8Array(64)),'1'.repeat(64));assert.equal(base58(new TextEncoder().encode('Hello World')),'JxF12TrwUP45BMd')});

test('classic ignores stale enhanced settings and fixes the launch payload',()=>{
 const p=launchPayload({...draft,version:'v1',cap:'invalid',blocked:'bad wallet',apps:'bad app',appMode:'only',devBuy:'10',mode:'quick'},options);
 assert.equal(p.version,'v1');assert.deepEqual(p.blockedWallets,[]);
 assert.deepEqual(Object.keys(p.config).sort(),['name','ticker','uri','beneficiary','developerBuyLamports'].sort());
 assert.equal(p.config.developerBuyLamports,'10000000000');
 assert.equal(launchPayload({...draft,version:undefined},options).version,'v1');
 assert.throws(()=>launchPayload({...draft,version:'other'},options));
});
