// Only retry read/simulation calls on a fallback. Never replay a submitted transaction.
export function rpcFetch({primary,fallback,fetchImpl=fetch,now=Date.now}){
 const cooling=new Map();
 return async(url,options)=>{
  let method='';try{method=JSON.parse(options?.body??'{}').method??''}catch{}
  const readOnly=method.startsWith('get')||method==='simulateTransaction';
  if(!readOnly||String(url)!==primary||!fallback)return fetchImpl(url,options);
  const endpoints=[primary,fallback],ready=endpoints.filter(e=>(cooling.get(e)??0)<=now());
  let lastResponse,lastError;
  for(const endpoint of ready.length?ready:endpoints){
   try{
    const response=await fetchImpl(endpoint,{...options,signal:options?.signal??AbortSignal.timeout(10000)});lastResponse=response;
    let limited=[403,429,502,503,504].includes(response.status);
    if(response.ok){try{const body=await response.clone().json();limited=[-32005,-32429].includes(body.error?.code)}catch{}}
    if(!limited)return response;
    cooling.set(endpoint,now()+15000);
   }catch(error){lastError=error;cooling.set(endpoint,now()+15000)}
  }
  if(lastResponse)return lastResponse;
  throw lastError??Error('RPC temporarily unavailable');
 };
}
