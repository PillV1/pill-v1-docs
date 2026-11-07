export function checkedDisplayPrice(body,now=Date.now()){
 const price=Number(body.price),publishedAt=Date.parse(body.time);
 if(!Number.isFinite(price)||price<=0||!Number.isFinite(publishedAt)||publishedAt>now+5000||now-publishedAt>60000)throw Error('stale_display_price');
 return {price,publishedAt,expiresAt:publishedAt+60000,source:'coinbase_SOL_USD',displayOnly:true};
}
export class DisplayPrice {
 constructor({fetchImpl=fetch,clock=Date.now}={}){this.fetch=fetchImpl;this.clock=clock;this.cached=null;this.pending=null;this.retryAt=0}
 async read(){
  const now=this.clock();if(this.cached&&now-this.fetchedAt<10000&&this.cached.expiresAt>now)return this.cached;
  if(this.pending)return this.pending;if(now<this.retryAt)throw Error('display_price_unavailable');
  this.pending=(async()=>{try{const response=await this.fetch('https://api.exchange.coinbase.com/products/SOL-USD/ticker',{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)throw Error('display_price_unavailable');const text=await response.text();if(text.length>8192)throw Error('invalid_display_price');this.cached=checkedDisplayPrice(JSON.parse(text),this.clock());this.fetchedAt=this.clock();return this.cached}catch(error){this.retryAt=this.clock()+10000;throw error}})();
  try{return await this.pending}finally{this.pending=null}
 }
}
