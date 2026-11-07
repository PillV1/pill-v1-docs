// Bounded shared cache for public read-only snapshots. Errors are never cached.
export function cachedRead(load,{ttlMs=3000,maxEntries=256,maxPending=32,now=Date.now}={}){
 const cache=new Map(),pending=new Map();
 return async key=>{
  const hit=cache.get(key);if(hit&&hit.until>now())return hit.value;
  if(pending.has(key))return pending.get(key);
  if(pending.size>=maxPending)throw Error('read_capacity_unavailable');
  const task=Promise.resolve().then(()=>load(key)).then(value=>{if(cache.size>=maxEntries)cache.delete(cache.keys().next().value);cache.set(key,{value,until:now()+ttlMs});return value}).finally(()=>pending.delete(key));
  pending.set(key,task);return task;
 };
}
