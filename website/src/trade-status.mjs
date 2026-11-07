// Never confuse a slot number with block height. Validate the actual blockhash.
export async function reconcileTrade(connection,record){
 if(!record?.signature||!record.blockhash)return {state:'unknown'};
 const read=async()=> (await connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value?.[0];
 const classify=status=>status?.confirmationStatus==='finalized'?{state:status.err?'failed':'finalized',error:status.err??null}:{state:'pending'};
 const status=await read();if(status)return classify(status);
 if((await connection.isBlockhashValid(record.blockhash,{commitment:'confirmed'})).value)return {state:'pending'};
 if((await connection.isBlockhashValid(record.blockhash,{commitment:'finalized'})).value)return {state:'pending'};
 const checked=await read();return checked?classify(checked):{state:'expired'};
}
export async function confirmTrade(connection,record,{timeoutMs=60000,pollMs=1500}={}){
 const end=Date.now()+timeoutMs;
 do{
  const result=await reconcileTrade(connection,record);
  if(result.state==='finalized')return record.signature;
  if(result.state==='failed')throw Error('Transaction failed on chain.');
  if(result.state==='expired')throw Error('Transaction expired without confirmation.');
  await new Promise(resolve=>setTimeout(resolve,pollMs));
 }while(Date.now()<end);
 throw Error('Transaction confirmation is still pending.');
}
