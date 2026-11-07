// Display/configuration conversion only. On-chain accounting always uses integer lamports.
// HTTPS provider trust is explicit; this does not claim to verify a Pyth update on-chain.
export const SOL_USD_FEED='ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
export function checkedPrice(payload,now){
 const rows=payload?.parsed;if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==SOL_USD_FEED)throw Error('price_feed_mismatch');
 const p=rows[0].price;
 if(!p||! /^[1-9][0-9]{0,19}$/.test(p.price)||! /^(0|[1-9][0-9]{0,19})$/.test(p.conf)||!Number.isInteger(p.expo)||p.expo< -12||p.expo>0||!Number.isSafeInteger(p.publish_time)||p.publish_time>now+5||now-p.publish_time>60)throw Error('stale_or_invalid_price');
 const price=BigInt(p.price),confidence=BigInt(p.conf);if(confidence*10000n>price*100n)throw Error('price_confidence_too_wide');
 return {price:p.price,confidence:p.conf,exponent:p.expo,publishedAt:p.publish_time,expiresAt:p.publish_time+60,feed:SOL_USD_FEED,source:'pyth_hermes_https',onchainVerified:false};
}
export function usdToLamports(usd,quote){
 if(typeof usd!=='string'||! /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/.test(usd))throw Error('invalid_usd_amount');
 const [whole,frac='']=usd.split('.'),micro=BigInt(whole)*1000000n+BigInt(frac.padEnd(6,'0'));
 if(micro<=0n||micro>100000000000000n)throw Error('usd_amount_out_of_range');
 const numerator=micro*1000000000n*10n**BigInt(-quote.exponent),denominator=BigInt(quote.price)*1000000n;
 const lamports=(numerator+denominator-1n)/denominator;if(lamports<=0n||lamports>9000000000000000n)throw Error('converted_amount_out_of_range');
 return {usd,lamports:lamports.toString(),rounding:'up_to_lamport',quote};
}
export class UsdQuotes {
 constructor({apiKey,fetchImpl=fetch,clock=()=>Math.floor(Date.now()/1000)}={}){this.apiKey=apiKey;this.fetch=fetchImpl;this.clock=clock;this.cached=null;this.pending=null}
 async price(){
  if(!this.apiKey)throw Error('price_provider_not_configured');
  const now=this.clock();if(this.cached&&now-this.cached.fetchedAt<5&&now<=this.cached.quote.expiresAt)return this.cached.quote;
  if(this.pending)return this.pending;
  this.pending=(async()=>{const url=new URL('https://pyth.dourolabs.app/hermes/v2/updates/price/latest');url.search=new URLSearchParams({'ids[]':SOL_USD_FEED,parsed:'true',encoding:'base64'});
   const response=await this.fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${this.apiKey}`}});if(!response.ok||!response.body)throw Error('price_provider_unavailable');
   const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw Error('price_response_too_large');chunks.push(Buffer.from(value))}}finally{await reader.cancel()}
   const quote=checkedPrice(JSON.parse(Buffer.concat(chunks).toString('utf8')),this.clock());this.cached={quote,fetchedAt:this.clock()};return quote;
  })();try{return await this.pending}finally{this.pending=null}
 }
 async convert(usd){return usdToLamports(usd,await this.price())}
}
