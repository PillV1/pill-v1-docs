import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {suffixMatcher,searchVanity} from '../src/vanity-search.mjs';
import {generateVanityMint,validateVanityMint} from '../src/vanity-mint.mjs';
test('numeric suffix matching agrees with Base58 encoding',()=>{
 for(let i=0;i<1000;i++){
  const key=Keypair.generate().publicKey,address=key.toBase58();
  for(const suffix of ['piLL','PiLL',address.slice(-4)])assert.equal(suffixMatcher(suffix)(key.toBytes()),address.endsWith(suffix));
 }
 for(const suffix of ['pill','0','O','I','', 'tooLong'])assert.throws(()=>suffixMatcher(suffix));
});
test('search generates a genuine signable Ed25519 key',async()=>{
 const key=await searchVanity('L',()=>{});
 assert(key.publicKey.toBase58().endsWith('L'));
 assert.equal(Keypair.fromSecretKey(key.secretKey).publicKey.toBase58(),key.publicKey.toBase58());
 if(!key.publicKey.toBase58().endsWith('piLL'))assert.throws(()=>validateVanityMint(key.secretKey),/piLL/);
});
test('cancellation terminates every worker without returning a mint',async()=>{
 const workers=[],controller=new AbortController();
 const promise=generateVanityMint({signal:controller.signal,concurrency:2,workerFactory:()=>{const w={postMessage(){},terminate(){this.terminated=true}};workers.push(w);return w}});
 controller.abort();await assert.rejects(promise,{name:'AbortError'});assert.equal(workers.length,2);assert(workers.every(w=>w.terminated));
});
test('worker errors and invalid matches fail closed',async()=>{
 for(const response of [{error:true},{secretKey:new Uint8Array(64)}]){
  let stopped=false;
  await assert.rejects(generateVanityMint({concurrency:1,workerFactory:()=>({postMessage(){queueMicrotask(()=>this.onmessage({data:response}))},terminate(){stopped=true}})}));
  assert(stopped);
 }
});
test('timeout stops generation instead of falling back to an ordinary mint',async()=>{
 let stopped=false;
 await assert.rejects(generateVanityMint({timeoutMs:5,concurrency:1,workerFactory:()=>({postMessage(){},terminate(){stopped=true}})}),/timed out/);
 assert(stopped);
});

test('prepared mint skips browser workers and clears the delivered secret',async()=>{
 const {readFileSync}=await import('node:fs');
 const secret=JSON.parse(readFileSync(new URL('./fixtures/public-test-mint-piLL.json',import.meta.url)));
 const pair=validateVanityMint(secret);
 const result=await generateVanityMint({reserveMint:async()=>({mint:pair.publicKey.toBase58(),secretKey:secret}),workerFactory:()=>{throw Error('must not run')}});
 assert.equal(result.publicKey.toBase58(),pair.publicKey.toBase58());assert.ok(secret.every(v=>v===0));
});
