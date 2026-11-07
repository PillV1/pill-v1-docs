import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {MintReserve} from '../services/api/mint-reserve.mjs';
const secret=JSON.parse(readFileSync(new URL('../website/tests/fixtures/public-test-mint-piLL.json',import.meta.url)));
const setup=()=>new MintReserve({database:':memory:',key:randomBytes(32),identity:{session:s=>{if(!['alice','bob'].includes(s))throw Error('unauthenticated');return {wallet:s}}}});
test('encrypted reserve assigns once, safely retries and never reissues to another wallet',()=>{const r=setup();try{const mint=r.add(secret);assert.equal(r.available(),1);const row=r.db.prepare('SELECT sealed FROM mint_reserve').get();assert.equal(Buffer.from(row.sealed).includes(Buffer.from(secret)),false);const one=r.claim('alice','request-1234567890',100);assert.equal(one.mint,mint);assert.deepEqual(one.secretKey,secret);assert.equal(r.available(),0);assert.deepEqual(r.claim('alice','request-1234567890',101),one);assert.throws(()=>r.claim('bob','request-1234567890',102),/unauthenticated/);assert.throws(()=>r.claim('bob','request-9876543210',102),/replenishing/);assert.throws(()=>r.claim('invalid','request-9876543210',102),/unauthenticated/);}finally{r.db.close()}});
test('tampered encrypted mint keys are rejected',()=>{const r=setup();try{r.add(secret);r.db.prepare('UPDATE mint_reserve SET sealed=?').run(randomBytes(92));assert.throws(()=>r.claim('alice','request-1234567890',100));assert.equal(r.available(),0);}finally{r.db.close()}});
test('invalid request ids and invalid mint keys cannot enter the reserve',()=>{const r=setup();try{assert.throws(()=>r.claim('alice','short',1),/invalid_request_id/);assert.throws(()=>r.add([1,2,3]));}finally{r.db.close()}});
test('API requires authentication and returns uncached reservation only to its owner',async()=>{
 const {application}=await import('../services/api/application.mjs');const r=setup();r.add(secret);
 const server=application({mintReserve:r,identity:r.identity,origin:'https://pillv1.fun'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/launch/mint/reserve';
 try{const request=token=>fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({requestId:'request-1234567890'})});
 assert.equal((await request('invalid')).status,401);assert.equal(r.available(),1);
 const response=await request('alice');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).mint.endsWith('piLL'),true);assert.equal((await request('bob')).status,401);
 }finally{await new Promise(resolve=>server.close(resolve));r.db.close()}
});
