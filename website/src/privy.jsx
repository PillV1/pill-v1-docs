import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PrivyProvider,usePrivy,useLogin,useLinkAccount,getIdentityToken} from '@privy-io/react-auth';
let root,active;
export function connectX(appId,api){
 if(active)return active;
 active=new Promise((resolve,reject)=>{
  const host=document.createElement('div');document.body.append(host);
  const finish=(error,result)=>{setTimeout(()=>{root?.unmount();host.remove();active=null},0);error?reject(error):resolve(result)};
  root=createRoot(host);root.render(<PrivyProvider appId={appId} config={{loginMethods:['twitter'],appearance:{theme:'dark',accentColor:'#a4f5c4'}}}><Connect api={api} finish={finish}/></PrivyProvider>);
 });return active;
}
function Connect({api,finish}){
 const {ready,authenticated,user}=usePrivy();const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function save(){setBusy(true);try{const identityToken=await getIdentityToken();if(!identityToken)throw Error('Please sign in to X again.');finish(null,await api.request('/auth/privy/x',{method:'POST',body:{identityToken}}))}catch(e){setError(e.message);setBusy(false)}}
 const {login}=useLogin({onError:()=>{setError('X sign-in was not completed.');setBusy(false)}});
 const {linkTwitter}=useLinkAccount({onError:()=>{setError('X linking was not completed.');setBusy(false)}});
 useEffect(()=>{if(ready&&authenticated&&user?.twitter)save()},[ready,authenticated,user?.twitter?.subject]);
 return <div style={{position:'fixed',inset:0,zIndex:900,background:'#000a',display:'grid',placeItems:'center'}}><section className="panel stack" style={{width:'min(420px,90vw)'}}><h2>Connect your X account</h2><p>Link your X identity to your connected payout wallet.</p>{error&&<p role="alert">{error}</p>}<button className="primary" disabled={!ready||busy} onClick={()=>{setError('');if(authenticated){if(user?.twitter)save();else linkTwitter()}else login({loginMethods:['twitter']})}}>{busy?'Verifying…':authenticated&&user?.twitter?'Verify connection':'Continue with X'}</button><button onClick={()=>finish(Error('X connection cancelled.'))}>Cancel</button></section></div>;
}
