// Public wallet lists are source claims, not proof of identity or malicious behavior.
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {addBlockedWalletInstruction} from '../../sdk/src/instructions.mjs';
const address=value=>{if(typeof value!=='string')throw Error('invalid_wallet');const key=new PublicKey(value.trim());return key.toBase58()};
export function normalizeCatalog(raw,{sourceUrl,capturedAt}) {
 if(!/^https:\/\//.test(sourceUrl)||!Number.isFinite(Date.parse(capturedAt)))throw Error('invalid_provenance');
 const entries=[];
 for(const source of ['pump','kolscan']) {
  if(!Array.isArray(raw[source]))throw Error('missing_source');
  for(const row of raw[source]) {
   if(!Array.isArray(row.wallets)||row.wallets.length===0)throw Error('missing_wallets');
   const wallets=[...new Set(row.wallets.map(address))].sort();
   entries.push({id:source+':'+wallets[0],source,name:String(row.name??'').slice(0,160),x:String(row.x??'').slice(0,80),wallets});
  }
 }
 const ids=new Set();for(const row of entries){if(ids.has(row.id))throw Error('duplicate_identity');ids.add(row.id)}
 entries.sort((a,b)=>a.id.localeCompare(b.id));
 return {version:1,sourceUrl,capturedAt,entries,digest:createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
}
export function blocklistSnapshot(catalog,{sources=[],excludedIds=[],custom=[]}={}) {
 if(sources.some(s=>!['pump','kolscan'].includes(s)))throw Error('invalid_source');
 const known=new Set(catalog.entries.map(x=>x.id));
 if(excludedIds.some(id=>!known.has(id)))throw Error('unknown_exclusion');
 const excluded=new Set(excludedIds);
 const addresses=[...new Set([...catalog.entries.filter(x=>sources.includes(x.source)&&!excluded.has(x.id)).flatMap(x=>x.wallets),...custom.map(address)])].sort();
 if(addresses.length>10000)throw Error('blocklist_too_large');
 return {addresses,count:addresses.length,catalogDigest:catalog.digest,digest:createHash('sha256').update(JSON.stringify(addresses)).digest('hex')};
}
export function uploadPlan({program,mint,creator,snapshot}) {
 // Put the count into create-launch args first. Trading stays closed until every entry exists.
 return snapshot.addresses.map(wallet=>addBlockedWalletInstruction({program,mint,creator,wallet}));
}
