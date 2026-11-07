import {Keypair} from '@solana/web3.js';
export const MINT_SUFFIX='piLL';
export function validateVanityMint(secretKey){
 const mint=Keypair.fromSecretKey(new Uint8Array(secretKey));
 if(!mint.publicKey.toBase58().endsWith(MINT_SUFFIX))throw Error('Generated mint does not end in piLL. Please try again.');
 return mint;
}
// Prepared mint keys are delivered over the authenticated API and kept in memory only.
// The local worker path is retained for isolated development tests.
export function generateVanityMint({reserveMint,signal,onProgress=()=>{},workerFactory=()=>new Worker(new URL('./vanity-worker.js',import.meta.url),{type:'module'}),concurrency=Math.min(2,Math.max(1,(globalThis.navigator?.hardwareConcurrency||2)-1)),timeoutMs=30*60*1000}={}){
 if(reserveMint)return reserveMint().then(result=>{try{const mint=validateVanityMint(result.secretKey);if(mint.publicKey.toBase58()!==result.mint)throw Error('Mint reservation mismatch.');if(signal?.aborted)throw new DOMException('Launch preparation cancelled.','AbortError');return mint}finally{result.secretKey?.fill(0)}});
 return new Promise((resolve,reject)=>{
  const workers=[],counts=[];let settled=false,timer;
  const finish=(error,mint)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const worker of workers)worker.terminate();error?reject(error):resolve(mint)};
  const abort=()=>finish(new DOMException('Address search cancelled. No transaction was sent.','AbortError'));
  if(signal?.aborted){abort();return}
  signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>finish(Error('Address search timed out. No transaction was sent. Try again on a faster device.')),timeoutMs);
  try{for(let i=0;i<concurrency;i++){
   const worker=workerFactory();workers.push(worker);counts[i]=0;
   worker.onerror=()=>finish(Error('Address search could not run. Please try again in a browser that supports Web Workers.'));
   worker.onmessage=({data})=>{
    if(settled)return;
    if(data?.secretKey){try{const mint=validateVanityMint(data.secretKey);data.secretKey.fill(0);finish(null,mint)}catch(error){finish(error)}return}
    if(data?.error){finish(Error('Address generation failed. No transaction was sent.'));return}
    if(Number.isSafeInteger(data?.attempts)&&data.attempts>=0){counts[i]=data.attempts;onProgress(counts.reduce((a,b)=>a+b,0))}
   };
   worker.postMessage({suffix:MINT_SUFFIX});
  }}catch(error){finish(error)}
 });
}
