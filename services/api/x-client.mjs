async function json(response){
 if(!response.ok)throw Error(`x_http_${response.status}`);
 if(!response.body)throw Error('x_empty_response');const reader=response.body.getReader();let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw Error('x_response_too_large');chunks.push(Buffer.from(value))}}finally{await reader.cancel()}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export class XPostReader {
 constructor({bearerToken,fetchImpl=fetch}){this.bearerToken=bearerToken;this.fetchImpl=fetchImpl}
 async posts(ids){
  if(!this.bearerToken)throw Error('x_read_access_not_configured');
  if(!Array.isArray(ids)||ids.length<1||ids.length>100||ids.some(id=>! /^[0-9]{1,30}$/.test(id)))throw Error('invalid_post_ids');
  const u=new URL('https://api.x.com/2/tweets');u.search=new URLSearchParams({ids:[...new Set(ids)].join(','),'tweet.fields':'author_id,created_at,public_metrics,edit_history_tweet_ids,referenced_tweets'});
  const result=await json(await this.fetchImpl(u,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${this.bearerToken}`}}));
  if(!Array.isArray(result.data)||result.errors?.length)throw Error('incomplete_x_lookup');return result.data;
 }
}
export class XClient extends XPostReader {
 constructor({clientId,clientSecret,redirectUri,bearerToken,fetchImpl=fetch}){
  super({bearerToken,fetchImpl});
  if(!clientId||!clientSecret||!redirectUri||new URL(redirectUri).protocol!=='https:')throw Error('x_configuration_required');
  Object.assign(this,{clientId,clientSecret,redirectUri,bearerToken,fetchImpl});
 }
 authorizationUrl(state,challenge){const u=new URL('https://x.com/i/oauth2/authorize');u.search=new URLSearchParams({response_type:'code',client_id:this.clientId,redirect_uri:this.redirectUri,scope:'users.read tweet.read',state,code_challenge:challenge,code_challenge_method:'S256'});return u.toString()}
 async identify(code,verifier){
  if(typeof code!=='string'||code.length>2048)throw Error('invalid_oauth_code');
  const credentials=Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64');
  const result=await json(await this.fetchImpl('https://api.x.com/2/oauth2/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Basic ${credentials}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:this.redirectUri,code_verifier:verifier,client_id:this.clientId})}));
  if(typeof result.access_token!=='string'||result.access_token.length>8192)throw Error('invalid_x_token');
  const profile=await json(await this.fetchImpl('https://api.x.com/2/users/me',{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${result.access_token}`}}));
  if(!profile.data)throw Error('x_profile_missing');return profile.data;
 }

}
