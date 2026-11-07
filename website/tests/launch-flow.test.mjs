import test from 'node:test';
import assert from 'node:assert/strict';
import {runLaunchFlow} from '../src/launch-flow.mjs';
const base=()=>({step:0,stageCount:3,pending:null});
test('automatically progresses through readiness waits and approvals',async()=>{
 const record=base();let attempts=0,waits=0;
 const result=await runLaunchFlow({record,canContinue:()=>true,reconcile:()=>{},wait:async()=>{waits++},advance:async()=>{attempts++;if(attempts===2)return {waiting:'oracle'};record.step++}});
 assert.deepEqual(result,{done:true});assert.equal(attempts,4);assert.equal(waits,1);
});
test('uncertain submissions reconcile without signing again',async()=>{
 const record={...base(),stageCount:1};let signs=0,checks=0;
 const result=await runLaunchFlow({record,canContinue:()=>true,wait:async()=>{},advance:async()=>{signs++;record.pending={signature:'saved'}},reconcile:async()=>{checks++;if(checks===3){record.pending=null;record.step++}}});
 assert.deepEqual(result,{done:true});assert.equal(signs,1);assert.equal(checks,3);
});
test('navigation pauses before another approval',async()=>{
 const record=base();let active=true,calls=0;
 const result=await runLaunchFlow({record,canContinue:()=>active,wait:async()=>{active=false},advance:async()=>{calls++;return {waiting:'oracle'}},reconcile:()=>{}});
 assert.deepEqual(result,{paused:true});assert.equal(calls,1);
});
test('wallet rejection stops without retrying',async()=>{
 const record=base();let calls=0;
 await assert.rejects(runLaunchFlow({record,canContinue:()=>true,advance:async()=>{calls++;throw Error('Rejected')},reconcile:()=>{}}),/Rejected/);assert.equal(calls,1);
});
test('finalized failure stops before next stage',async()=>{
 const record={...base(),pending:{}};let signs=0;
 await assert.rejects(runLaunchFlow({record,canContinue:()=>true,advance:()=>{signs++},reconcile:async()=>{record.failure='Failed on chain'}}),/Failed on chain/);assert.equal(signs,0);
});
test('long wait preserves progress and times out without resubmission',async()=>{
 const record={...base(),pending:{signature:'saved'}};let time=0;
 const result=await runLaunchFlow({record,canContinue:()=>true,now:()=>time,timeoutMs:5000,wait:async()=>{time+=2500},reconcile:async()=>{},advance:()=>assert.fail('must not sign')});
 assert.match(result.waiting,/progress is saved/);assert.equal(record.pending.signature,'saved');
});
