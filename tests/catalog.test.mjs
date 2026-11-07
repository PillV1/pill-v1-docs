import test from 'node:test';import assert from 'node:assert/strict';import {Keypair} from '@solana/web3.js';
import {normalizeCatalog,blocklistSnapshot,uploadPlan} from '../services/catalog/wallets.mjs';
import {DEVELOPMENT_PROGRAM} from '../sdk/src/instructions.mjs';
const a=Keypair.generate().publicKey.toBase58(),b=Keypair.generate().publicKey.toBase58();
const provenance={sourceUrl:'https://example.com/public-list',capturedAt:'2026-11-04T12:00:00Z'};
const raw={pump:[{name:'A',wallets:[a]}],kolscan:[{name:'B',wallets:[a,b]}]};
test('source selection deduplicates wallets and records immutable digest',()=>{const c=normalizeCatalog(raw,provenance),s=blocklistSnapshot(c,{sources:['pump','kolscan']});assert.equal(s.count,2);assert.equal(s.digest,blocklistSnapshot(c,{sources:['kolscan','pump']}).digest);assert.equal(s.catalogDigest,c.digest)});
test('individual exclusions and custom wallets are explicit',()=>{const c=normalizeCatalog(raw,provenance);assert.deepEqual(blocklistSnapshot(c,{sources:['pump'],excludedIds:['pump:'+a],custom:[b,b]}).addresses,[b]);assert.throws(()=>blocklistSnapshot(c,{excludedIds:['missing']}));assert.throws(()=>blocklistSnapshot(c,{custom:['invalid']}))});
test('supports full KOL catalogue sizes instead of 32-wallet ceiling',()=>{const wallets=Array.from({length:1000},()=>Keypair.generate().publicKey.toBase58());const c=normalizeCatalog({pump:wallets.map(x=>({wallets:[x]})),kolscan:[]},provenance);const snapshot=blocklistSnapshot(c,{sources:['pump']});assert.equal(snapshot.count,1000);const plan=uploadPlan({program:DEVELOPMENT_PROGRAM,mint:Keypair.generate().publicKey,creator:Keypair.generate().publicKey,snapshot});assert.equal(plan.length,1000);assert(plan.every(x=>x.keys[0].isSigner))});
