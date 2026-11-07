import test from 'node:test';import assert from 'node:assert/strict';import {Keypair} from '@solana/web3.js';import {maintenanceKinds,maintenanceInstruction} from '../services/api/maintenance.mjs';import {DEVELOPMENT_PROGRAM} from '../sdk/src/instructions.mjs';
const mint=Keypair.generate().publicKey,keeper=Keypair.generate().publicKey,treasury=Keypair.generate().publicKey.toBase58(),creator=Keypair.generate().publicKey.toBase58();
const launch={treasury,creator,treasuryFees:10000n,randomnessReady:true,developerExecuted:true,graduated:false,quote:1000000000n,sold:30000000000000n,sniperFees:0n,coinFees:50000000n,args:{ticker:'TEST',feeMode:'holders',targetQuote:85000000000n,virtualTokens:1000000000000000n,virtualQuote:30000000000n,saleTokens:800000000000000n}};
const input={program:DEVELOPMENT_PROGRAM,mint,keeper,launch,slot:100n,unixTime:1000n};
test('maintenance preserves holder fees and blocks graduation or burns before developer allocation',()=>{
 assert.deepEqual(maintenanceKinds(launch,null,1000n),['keeper_treasury']);
 const pending={...launch,developerExecuted:false,sniperFees:500000n};assert.deepEqual(maintenanceKinds(pending,null,1000n),['keeper_treasury','keeper_developer_buy']);
 const full={...launch,quote:launch.args.targetQuote};assert.deepEqual(maintenanceKinds(full,null,1000n),['keeper_treasury','keeper_graduate']);
 assert.equal(maintenanceInstruction({...input,kind:'keeper_burn'}),null);
});
test('treasury and locked allocation destinations come from authenticated launch state',()=>{
 const ix=maintenanceInstruction({...input,kind:'keeper_treasury'});assert.equal(ix.keys[1].pubkey.toBase58(),treasury);
 const bonded={...launch,graduated:true},locked={balance:100n,unlockAt:2000n};assert(!maintenanceKinds(bonded,locked,1000n).includes('keeper_developer_claim'));
 const claim=maintenanceInstruction({...input,launch:bonded,position:locked,unixTime:2000n,kind:'keeper_developer_claim'});assert.equal(claim.keys[1].pubkey.toBase58(),creator);assert.equal(claim.keys[0].pubkey.toBase58(),keeper.toBase58());
});
test('sniper burns use bounded isolated budget and nonzero slippage minimum and deadline',()=>{
 const sniper={...launch,sniperFees:200000000n};const ix=maintenanceInstruction({...input,launch:sniper,kind:'keeper_burn'});
 assert.equal(ix.data.readBigUInt64LE(8),100000000n);assert(ix.data.readBigUInt64LE(16)>0n);assert.equal(ix.data.readBigUInt64LE(24),120n);
 const near={...sniper,quote:launch.args.targetQuote-1000n};assert.equal(maintenanceInstruction({...input,launch:near,kind:'keeper_burn'}).data.readBigUInt64LE(8),1000n);
 assert.equal(launch.coinFees,50000000n);
});

test('activation is queued only after committed blocklist uploads and never for cancelled launches',()=>{
 const pending={...launch,randomnessReady:false,activationRequested:true,blockedUploaded:2,args:{...launch.args,extraBlockedCount:2}};
 assert(maintenanceKinds(pending,null,1000n).includes('keeper_activate'));
 assert(!maintenanceKinds({...pending,blockedUploaded:1},null,1000n).includes('keeper_activate'));
 assert(!maintenanceKinds({...pending,activationRequested:false},null,1000n).includes('keeper_activate'));
 assert.deepEqual(maintenanceKinds({...pending,cancelled:true},null,1000n),[]);
});
