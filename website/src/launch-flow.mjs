// A single user-started run. Uncertain submissions are reconciled, never re-signed.
export async function runLaunchFlow({record,advance,reconcile,canContinue,onUpdate=()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,timeoutMs=600000}){
 const started=now();
 while(canContinue()){
  if(record.failure)throw Error(record.failure);
  if(record.step>=record.stageCount&&!record.pending)return {done:true};
  if(now()-started>=timeoutMs)return {waiting:'This launch is taking longer than usual. Your progress is saved. Resume to check it safely.'};
  let result;
  if(record.pending){await reconcile();result={waiting:record.pending?'Confirming your transaction…':null}}
  else result=await advance();
  onUpdate(result||{});
  if(record.failure)throw Error(record.failure);
  if(record.step>=record.stageCount&&!record.pending)return {done:true};
  if(record.pending||result?.waiting)await wait(2500);
 }
 return {paused:true};
}
