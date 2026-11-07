import {searchVanity} from './vanity-search.mjs';
let started=false;
self.onmessage=async({data})=>{
 if(started)return;started=true;
 try{
  if(data?.suffix!=='piLL')throw Error('Unsupported suffix');
  let last=0;
  const mint=await searchVanity(data.suffix,attempts=>{if(Date.now()-last>750){last=Date.now();self.postMessage({attempts})}});
  const secretKey=mint.secretKey;
  self.postMessage({secretKey},[secretKey.buffer]);
 }catch{self.postMessage({error:true})}
};
