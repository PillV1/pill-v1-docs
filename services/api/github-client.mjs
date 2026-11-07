// GitHub's documented authorization-code + S256 PKCE flow. No token persistence.
async function read(response){
 if(!response.ok||!response.body)throw Error('github_request_failed');
 const reader=response.body.getReader();let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw Error('github_response_too_large');chunks.push(Buffer.from(value));}}finally{await reader.cancel()}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export class GitHubClient{
 constructor({clientId,clientSecret,redirectUri,fetchImpl=fetch}){if(!clientId||!clientSecret||!redirectUri||new URL(redirectUri).protocol!=='https:')throw Error('github_configuration_required');Object.assign(this,{clientId,clientSecret,redirectUri,fetchImpl});}
 authorizationUrl(state,challenge){const u=new URL('https://github.com/login/oauth/authorize');u.search=new URLSearchParams({client_id:this.clientId,redirect_uri:this.redirectUri,state,code_challenge:challenge,code_challenge_method:'S256'});return u.toString();}
 async identify(code,verifier){
  if(typeof code!=='string'||!code||code.length>2048)throw Error('invalid_oauth_code');
  const result=await read(await this.fetchImpl('https://github.com/login/oauth/access_token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,code,redirect_uri:this.redirectUri,code_verifier:verifier})}));
  if(typeof result.access_token!=='string'||!result.access_token||result.access_token.length>8192)throw Error('invalid_github_token');
  const p=await read(await this.fetchImpl('https://api.github.com/user',{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${result.access_token}`,'User-Agent':'Pill-V1'}}));
  if(!Number.isSafeInteger(p.id)||p.id<=0||typeof p.login!=='string'||! /^[a-zA-Z0-9-]{1,39}$/.test(p.login))throw Error('invalid_github_identity');return {id:String(p.id),username:p.login};
 }
}
