import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {Keypair,PublicKey} from '@solana/web3.js';
import {readLaunchRules} from '../services/api/launch-rules.mjs';import {classicAddresses} from '../sdk/src/classic.mjs';
test('feature labels come from finalized, owner-checked classic account',async()=>{
 const program=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,owner=Keypair.generate().publicKey;
 const a=classicAddresses(program,mint),data=Buffer.alloc(186);createHash('sha256').update('account:ClassicLaunch').digest().copy(data,0,0,8);owner.toBuffer().copy(data,8);mint.toBuffer().copy(data,40);owner.toBuffer().copy(data,72);new PublicKey('11111111111111111111111111111111').toBuffer().copy(data,104);data[136]=a.bump;
 const snapshot={context:{slot:10},value:[{owner:program,data,executable:false},null]};
 const connection={getGenesisHash:async()=>'test',getMultipleAccountsInfoAndContext:async(_,options)=>{assert.equal(options.commitment,'finalized');return snapshot}};
 const input={connection,program,genesis:'test',mint};const rules=await readLaunchRules(input);assert.equal(rules.version,'v1');assert.equal(rules.buySlotCapBps,100);assert.equal(rules.buySlotCapScope,'all-wallets-pregraduation');assert.equal(rules.feeBps,220);assert.equal(rules.blockedWalletCount,0);assert.equal(rules.commitment,'finalized');
 snapshot.value[0].owner=owner;await assert.rejects(readLaunchRules(input),/owner_mismatch/);
 snapshot.value[1]={};await assert.rejects(readLaunchRules(input),/ambiguous/);
 await assert.rejects(readLaunchRules({...input,genesis:'other'}),/wrong_cluster/);
});
test('curve breakdown distinguishes token-sale progress from deposited SOL',async()=>{
 const {curveSnapshot}=await import('../services/api/launch-rules.mjs');const {CLASSIC}=await import('../sdk/src/classic.mjs');
 const q=curveSnapshot({sold:CLASSIC.saleTokens*85n/100n,quote:50703997594n,graduated:false},{...CLASSIC,virtualQuote:CLASSIC.virtualSol});
 assert.equal(q.progressBps,8500);assert.equal(q.reserveLamports,'50703997594');assert.equal(q.remainingTokensRaw,(CLASSIC.saleTokens*15n/100n).toString());
});
