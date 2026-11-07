import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchLabels} from '../src/launch-labels.mjs';
test('classic stays a single label even with verified fee settings',()=>{
 assert.deepEqual(launchLabels(1,{version:'v1',commitment:'finalized',feeBps:220}),['Stealth Classic · V1']);
});
test('advanced labels use verified actual rules and distinguish wallet caps from buy limits',()=>{
 assert.deepEqual(launchLabels(11,{version:'v1.1',commitment:'finalized',maxWalletBps:300,feeMode:'yap',blockedWalletCount:2,quickBond:true,protectionSlots:5}),['Stealth · V1.1','3% max wallet','Raider rewards','2 blocked wallets','Quick bond','Opening protection']);
 assert.deepEqual(launchLabels(11,{maxWalletBps:300}),['Stealth · V1.1']);
 assert.deepEqual(launchLabels(11,{commitment:'finalized',maxWalletBps:0,feeMode:'burn'}),['Stealth · V1.1','Burns']);
});
test('graduated coins do not imply curve restrictions still apply',()=>{
 assert.deepEqual(launchLabels(11,{version:'v1.1',commitment:'finalized',graduated:true,maxWalletBps:300,feeMode:'burn'}),['Stealth · V1.1','Graduated · curve rules ended']);
});
