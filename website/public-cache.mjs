// Collapse simultaneous public reads within an edge isolate. Never use for
// wallet state, authentication, quotes, signing, or writes.
const pending=new Map();
export function publicCacheKey(url){const u=new URL(url);u.searchParams.sort();return new Request(u.href);}
export async function publicRead(request,ctx,load,ttl=2,cache=caches.default){
 const key=publicCacheKey(request.url),saved=await cache.match(key);if(saved)return saved;
 const id=key.url;
 if(pending.has(id))return (await pending.get(id)).clone();
 if(pending.size>=128)return Response.json({error:'read_capacity_unavailable'},{status:503,headers:{'Retry-After':'2','Cache-Control':'no-store'}});
 const task=(async()=>{const r=await load();if(!r.ok||r.headers.has('set-cookie'))return r;const out=new Response(await r.arrayBuffer(),r);out.headers.set('Cache-Control',`public,max-age=${ttl}`);await cache.put(key,out.clone());return out;})();
 pending.set(id,task);
 try{return (await task).clone()}finally{pending.delete(id)}
}
