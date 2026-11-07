import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('async function signTrade()'),app.indexOf('\ndocument.addEventListener',app.indexOf('async function signTrade()'))).replace("await import(preparedTrade?.nativePump?'./native-pump.js':'./wallet.js')",'await loadSigner()');
function context(sendPrepared){
 const button={disabled:false,isConnected:true,dataset:{action:'sign-trade'},textContent:''},error={textContent:''},records=new Map();
 const ctx=vm.createContext({button,error,errorText:e=>e.message,tradePending:false,preparedTrade:{},provider:{},config:{},sessionStorage:{setItem:(k,v)=>records.set(k,v),getItem:k=>records.get(k),removeItem:k=>records.delete(k)},modal:{querySelector:s=>s==='#trade-error'?error:button,close:()=>{button.isConnected=false}},loadSigner:async()=>({sendPrepared}),toast:()=>{},render:()=>{}});
 vm.runInContext(source,ctx);return {ctx,button,error,records};
}
test('wallet refusal or expired quote offers a fresh quote instead of leaving approval disabled',async()=>{
 for(const message of ['User rejected the request.','Quote expired.']){
  const {ctx,button,error}=context(async()=>{throw Error(message)});await ctx.signTrade();
  assert.equal(ctx.tradePending,false);assert.equal(button.disabled,false);assert.equal(button.dataset.action,'refresh-trade');assert.equal(error.textContent,message);
 }
});
test('an uncertain signed submission remains blocked from double spending',async()=>{
 const {ctx,button}=context(async(p,t,c,onSigned)=>{onSigned({signature:'sig',lastValidBlockHeight:123});throw Error('RPC timeout')});await ctx.signTrade();
 assert.equal(ctx.tradePending,true);assert.equal(button.disabled,true);assert.equal(button.dataset.action,'sign-trade');
});
test('finalized success clears the pending record and closes the review',async()=>{
 const {ctx,button,records}=context(async(p,t,c,onSigned)=>{onSigned({signature:'sig',lastValidBlockHeight:123});return {signature:'sig',confirm:async()=>{}}});await ctx.signTrade();
 assert.equal(ctx.tradePending,false);assert.equal(records.size,0);assert.equal(button.isConnected,false);
});
