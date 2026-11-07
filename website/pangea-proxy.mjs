import {publicRead} from './public-cache.mjs';
const base='https://www.pangea.trade/api/';
export async function pangeaProxy(request,ctx){
 const u=new URL(request.url),action=u.pathname.split('/').at(-1);
 let path,body;
 if(request.method==='GET'&&['history','coin'].includes(action)){
  const id=u.searchParams.get('id');if(!/^0x[0-9a-f]{64}$/i.test(id||''))return Response.json({error:'Invalid launch'},{status:400});
  const interval=Number(u.searchParams.get('interval')||900);if(![60,300,900,3600,14400,86400].includes(interval))return Response.json({error:'Invalid interval'},{status:400});
  path=action==='coin'?'coin/'+id:`history?launch=${id}&interval=${interval}&hours=168`;
 }else if(request.method==='POST'&&action==='quote'){
  if(Number(request.headers.get('content-length'))>2048)return new Response(null,{status:413});
  const text=await request.text();if(text.length>2048)return new Response(null,{status:413});
  try{const b=JSON.parse(text);if(!/^[a-zA-Z0-9_-]{1,100}$/.test(b.slug)||!['buy','sell'].includes(b.side)||!/^\d{1,22}$/.test(b.amount)||BigInt(b.amount)<=0n||! /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.solanaUser)||!Number.isInteger(b.slippageBps)||b.slippageBps<1||b.slippageBps>1000)throw Error();body={slug:b.slug,side:b.side,amount:b.amount,solanaUser:b.solanaUser,slippageBps:b.slippageBps,chain:'solana',mode:'direct',intent:'execute'};}catch{return Response.json({error:'Invalid Solana trade'},{status:400})}
  path='trade/quote';
 }else return new Response(null,{status:405});
 const load=async()=>{try{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});return Response.json(await r.json(),{status:r.status,headers:{'Cache-Control':'no-store'}})}catch{return Response.json({error:'Pangea market is temporarily unavailable. Please retry.'},{status:503})}};
 return request.method==='GET'?publicRead(request,ctx,load,action==='coin'?60:1):load();
}
