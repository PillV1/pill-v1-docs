import test from 'node:test';import assert from 'node:assert/strict';import {Keypair} from '@solana/web3.js';
import {CLASSIC,collectClassicFeesInstruction,graduateClassicInstruction} from '../sdk/src/classic.mjs';
import {maintenanceKinds,maintenanceInstruction} from '../services/api/maintenance.mjs';
const key=()=>Keypair.generate().publicKey;
test('classic maintenance collects immutable fees and graduates only on sold-out milestone',()=>{
 const program=key(),mint=key(),keeper=key(),launch={version:'v1',treasury:key(),fees:10000n,sold:0n,graduated:false};
 assert.deepEqual(maintenanceKinds(launch,null,0n),['keeper_treasury']);
 const args={program,mint,keeper,launch,unixTime:0n,slot:0n};
 const ix=maintenanceInstruction({...args,kind:'keeper_treasury'});assert.deepEqual(ix,collectClassicFeesInstruction({program,mint,treasury:launch.treasury}));
 assert.equal(maintenanceInstruction({...args,kind:'keeper_graduate'}),null);
 launch.sold=CLASSIC.saleTokens;assert.deepEqual(maintenanceKinds(launch,null,0n),['keeper_treasury','keeper_graduate']);
 assert.deepEqual(maintenanceInstruction({...args,kind:'keeper_graduate'}),graduateClassicInstruction({program,mint,keeper}));
 launch.graduated=true;assert.deepEqual(maintenanceKinds(launch,null,0n),['keeper_treasury']);
 launch.fees=0n;assert.deepEqual(maintenanceKinds(launch,null,0n),[]);
});
