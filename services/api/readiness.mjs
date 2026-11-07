import {verifyDeployment} from './deployment.mjs';
export function readiness({connection,config,db,privy,clock=()=>Math.floor(Date.now()/1000)}){
 let cached,pending,until=0;
 return async()=>{
  const now=clock();if(cached&&now<until)return cached;if(pending)return pending;
  pending=(async()=>{
   let deployed=false,reason='program_not_deployed';
   try{await verifyDeployment(connection,config);deployed=true;reason=null}catch(e){reason=/^[a-z_]+$/.test(e.message)?e.message:'deployment_unverified'}
   let fresh=false;try{const worker=db.prepare("SELECT last_success,last_error FROM worker_state WHERE name='indexer'").get();fresh=!!worker&&!worker.last_error&&now-worker.last_success<=30}catch{}
   const enabled=config.tradingEnabled===true&&config.directLaunchEnabled===true;
   cached={version:'0.6.0',launchVersions:['v1','v1.1'],versionSelectionReady:true,readyForFunds:deployed&&fresh&&enabled,contractsDeployed:deployed,reason:reason??(!fresh?'indexer_stale':!enabled?'live_transactions_disabled':null),network:config.network??'mainnet-beta',indexerFresh:fresh,program:config.program,treasury:config.treasury,metadata:!!config.mediaDirectory,socialLaunchIdentity:privy?'privy':'not_configured',supportedFeeModes:['burn','holders','liquidity','yap','creator'],graduationVenue:'pumpswap',appRestrictions:false,publicLaunchPayments:false,randomizedProtection:true,platformFeeBps:220,platformFeeScope:'bonding-curve-only'};until=now+15;return cached;
  })().finally(()=>{pending=null});return pending;
 };
}
