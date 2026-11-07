import {publicRead} from './public-cache.mjs';
import {pangeaProxy} from './pangea-proxy.mjs';
const origin='https://origin.example.invalid';
export function originRequestHeaders(request,token){
 const headers=new Headers();
 for(const name of ['accept','content-type','origin','authorization']){const value=request.headers.get(name);if(value)headers.set(name,value)}
 // Only our session is needed. Browser/Privy cookies and tracing headers can
 // exceed the origin HTTP parser's header budget, especially on uploads.
 const session=(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).find(v=>/^launchpad_session=[A-Za-z0-9_-]{1,100}$/.test(v));
 if(session)headers.set('cookie',session);
 headers.set('x-pill-client-ip',request.headers.get('cf-connecting-ip')??'');
 headers.set('x-pill-origin',token);
 return headers;
}
export default {
 async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname.startsWith("/api/pangea/"))return pangeaProxy(request,ctx);
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/media/')||/^\/auth\/(x|launch\/[^/]+)\/callback$/.test(url.pathname)){
   if(!['GET','POST','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
   const path=url.pathname.startsWith('/api/')?url.pathname.slice(4):url.pathname;
   if(path==='/health')return new Response('Not found',{status:404});
   // Origin token is an edge secret, never an asset or browser setting.
   if(!env.ORIGIN_TOKEN)return Response.json({error:'backend_not_configured'},{status:503});
   const headers=originRequestHeaders(request,env.ORIGIN_TOKEN);
   const cacheable=request.method==='GET'&&(/^\/(coins|stats|media)(\/|$)/.test(path)||['/holders','/launch/rules','/quotes/sol-usd','/capabilities','/profiles/public'].includes(path));
   try{
    const load=async()=>{const response=await fetch(origin+path+url.search,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual',signal:AbortSignal.timeout(25000)});
    if(response.status>=500)return Response.json({error:'backend_unavailable'},{status:503});
    return response;};
    if(cacheable){headers.delete('cookie');headers.delete('authorization');const ttl=path.startsWith('/media/')?31536000:path==='/capabilities'?30:path==='/profiles/public'?15:path.startsWith('/coins/')?1:2;return await publicRead(request,ctx,load,ttl)}
    return await load();
   }
   catch{return Response.json({error:'backend_unavailable'},{status:503})}
  }
  return env.ASSETS.fetch(request);
 }
};
