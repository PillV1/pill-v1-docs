import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {verifySocialSnapshot} from '../dist/claims.js';
import {addresses} from '../vendor/sdk/instructions.mjs';
import {rewardTree,socialRoundAddress} from '../vendor/sdk/social-rewards.mjs';
const key=n=>new PublicKey(new Uint8Array(32).fill(n)).toBase58(),program=key(1),mint=key(2),owner=key(3),hour=1;
const round=socialRoundAddress(program,mint,BigInt(hour)).toBase58(),tree=rewardTree(round,[{owner,amount:'1000'}]),proof={program,mint,owner,hour,round,root:tree.root,...tree.claims[0]},config={program};
function accounts(){const b=Buffer.alloc(96);createHash('sha256').update('account:SocialRound').digest().copy(b,0,0,8);addresses(program,mint).launch.toBuffer().copy(b,8);b.writeBigUInt64LE(1n,40);Buffer.from(tree.root,'hex').copy(b,48);b.writeBigUInt64LE(1000n,80);b.writeBigInt64LE(10000n,88);const clock=Buffer.alloc(40);clock.writeBigInt64LE(9000n,32);return [{owner:new PublicKey(program),executable:false,data:b},null,{data:clock}]}
test('browser bundle verifies a funded round and its owner-bound proof',()=>assert.equal(verifySocialSnapshot(config,mint,owner,proof,accounts()).claimable,true));
test('unfunded and already claimed plans cannot become claims',()=>{const a=accounts();a[0]=null;assert.equal(verifySocialSnapshot(config,mint,owner,proof,a).claimable,false);const b=accounts();b[1]={};assert.equal(verifySocialSnapshot(config,mint,owner,proof,b).label,'Already claimed')});
test('rejects wrong owner, mint, program and Merkle amount',()=>{for(const patch of [{owner:key(4)},{mint:key(4)},{program:key(4)},{amount:'1001'}])assert.throws(()=>verifySocialSnapshot(config,mint,owner,{...proof,...patch},accounts()))});
test('rejects account substitution and mismatched round root',()=>{const a=accounts();a[0].owner=new PublicKey(key(4));assert.throws(()=>verifySocialSnapshot(config,mint,owner,proof,a));const b=accounts();b[0].data[48]^=1;assert.throws(()=>verifySocialSnapshot(config,mint,owner,proof,b))});
test('expired and underfunded rounds cannot be claimed',()=>{const a=accounts();a[2].data.writeBigInt64LE(10001n,32);assert.equal(verifySocialSnapshot(config,mint,owner,proof,a).label,'Round expired');const b=accounts();b[0].data.writeBigUInt64LE(999n,80);assert.equal(verifySocialSnapshot(config,mint,owner,proof,b).claimable,false)});
