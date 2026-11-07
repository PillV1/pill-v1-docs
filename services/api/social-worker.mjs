// Private social settlement: frozen evidence -> fixed Merkle root -> owner-bound payouts.
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {decodeLaunch} from '../../sdk/src/accounts.mjs';
import {addresses} from '../../sdk/src/instructions.mjs';
import {socialRoundAddress,rewardTree,publishSocialRoundInstruction,claimSocialRewardInstruction,expireSocialRoundInstruction} from '../../sdk/src/social-rewards.mjs';
import {maintenanceSnapshot} from './maintenance.mjs';
import {signedEnvelope} from './maintenance.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
const key=x=>new PublicKey(x).toBase58();
const tag=name=>createHash('sha256').update(`account:${name}`).digest().subarray(0,8);
export function decodeSocialRound(account,{program,mint,hour}){
 if(!account)return null;
 const b=Buffer.from(account.data);
 if(account.executable||key(account.owner)!==key(program)||b.length!==96||!b.subarray(0,8).equals(tag('SocialRound')))throw Error('invalid_social_round');
 if(key(b.subarray(8,40))!==key(addresses(program,mint).launch)||b.readBigUInt64LE(40)!==BigInt(hour))throw Error('social_round_identity_mismatch');
 return {root:b.subarray(48,80).toString('hex'),remaining:b.readBigUInt64LE(80),expiresAt:b.readBigInt64LE(88)};
}
export function receiptAddress(program,round,owner){return PublicKey.findProgramAddressSync([Buffer.from('social-receipt'),new PublicKey(round).toBuffer(),new PublicKey(owner).toBuffer()],new PublicKey(program))[0]}
function paidReceipt(account,{program,round,claim}){
 if(!account)return false;const b=Buffer.from(account.data);
 if(account.executable||key(account.owner)!==key(program)||b.length!==80||!b.subarray(0,8).equals(tag('SocialReceipt'))||key(b.subarray(8,40))!==claim.owner||key(b.subarray(40,72))!==round||b.readBigUInt64LE(72)!==BigInt(claim.amount))throw Error('invalid_social_receipt');return true;
}
export function loadSocialPlan(db,program,mint,hour){
 const row=db.prepare('SELECT body,hash FROM social_round_plans WHERE mint=? AND hour=?').get(key(mint),hour);if(!row||hash(row.body)!==row.hash)throw Error('social_plan_integrity');
 const p=JSON.parse(row.body);if(p.program!==key(program)||p.mint!==key(mint)||p.hour!==hour||p.round!==key(socialRoundAddress(program,mint,BigInt(hour))))throw Error('social_plan_identity');
 const tree=rewardTree(p.round,p.claims);if(JSON.stringify(tree.claims)!==JSON.stringify(p.claims)||tree.root!==p.root||tree.budget!==p.budget)throw Error('social_plan_integrity');return p;
}
function enqueue(db,kind,mint,hour,owner){const body={mint,hour,...(owner?{owner}:{})};db.prepare('INSERT OR IGNORE INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)').run([kind,mint,hour,owner??''].join(':'),kind,kind==='keeper_social_publish'?mint:`social:${mint}:${hour}:${owner??'expiry'}`,JSON.stringify(body))}
export async function queueSocialPlan({db,connection,program,plan,unixTime}){
 const round=decodeSocialRound(await connection.getAccountInfo(new PublicKey(plan.round),'finalized'),{program,mint:plan.mint,hour:plan.hour});
 if(!round){enqueue(db,'keeper_social_publish',plan.mint,plan.hour);return 'unpublished'}
 if(round.root!==plan.root||round.remaining>BigInt(plan.budget))throw Error('social_round_conflict');
 if(unixTime>round.expiresAt){if(round.remaining>0n)enqueue(db,'keeper_social_expire',plan.mint,plan.hour);return 'expired'}
 if(round.remaining===0n)return 'paid';
 // Bound provider requests; receipt accounts, not database job status, establish payment.
 for(let start=0;start<plan.claims.length;start+=48){const claims=plan.claims.slice(start,start+48),accounts=await connection.getMultipleAccountsInfo(claims.map(c=>receiptAddress(program,plan.round,c.owner)),'finalized');
  for(let i=0;i<claims.length;i++)if(!paidReceipt(accounts[i],{program,round:plan.round,claim:claims[i]}))enqueue(db,'keeper_social_claim',plan.mint,plan.hour,claims[i].owner);
 }
 return 'published';
}
export async function planSocialMint({db,connection,program,mint,social,now}){
 mint=key(mint);const {launch,unixTime}=await maintenanceSnapshot(connection,program,mint);
 if(launch.version==='v1'||launch.args.feeMode!=='yap'||!launch.randomnessReady)return;
 // Reconcile one rotating page of older rounds, so a large history cannot starve new work.
 db.exec('CREATE TABLE IF NOT EXISTS social_scan_cursor(mint TEXT PRIMARY KEY,hour INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS social_empty_rounds(mint TEXT NOT NULL,hour INTEGER NOT NULL,PRIMARY KEY(mint,hour))');
 const cursor=db.prepare('SELECT hour FROM social_scan_cursor WHERE mint=?').get(mint)?.hour??-1;
 const rows=db.prepare('SELECT hour FROM social_round_plans WHERE mint=? AND hour>? ORDER BY hour LIMIT 4').all(mint,cursor);
 let pending=false;
 for(const row of rows){const plan=loadSocialPlan(db,program,mint,row.hour);if(await queueSocialPlan({db,connection,program,plan,unixTime})==='unpublished')pending=true;}
 db.prepare('INSERT INTO social_scan_cursor VALUES(?,?) ON CONFLICT(mint) DO UPDATE SET hour=excluded.hour').run(mint,rows.length?rows.at(-1).hour:-1);
 // A root whose publication is pending owns the available budget. Do not freeze a second one.
 const latest=db.prepare('SELECT hour FROM social_round_plans WHERE mint=? ORDER BY hour DESC LIMIT 1').get(mint);
 if(latest&&!rows.some(r=>r.hour===latest.hour)){const plan=loadSocialPlan(db,program,mint,latest.hour);if(await queueSocialPlan({db,connection,program,plan,unixTime})==='unpublished')pending=true;}
 if(pending)return;
 // Read the latest reservation and remaining budget from one finalized bank. A
 // publication between the earlier snapshot and this scan must not reserve it twice.
 const budgetKeys=[addresses(program,mint).launch,...(latest?[socialRoundAddress(program,mint,BigInt(latest.hour))]:[])];
 const budgetSnapshot=await connection.getMultipleAccountsInfoAndContext(budgetKeys,{commitment:'finalized'});
 const fresh=decodeLaunch({account:budgetSnapshot.value[0],address:budgetKeys[0],program,mint});
 if(latest&&!decodeSocialRound(budgetSnapshot.value[1],{program,mint,hour:latest.hour}))return;
 if(fresh.coinFees<10000n)return;
 const eligible=Math.floor((Math.min(now,Number(unixTime))-1800)/3600)-1;
 const candidate=db.prepare(`WITH candidates AS (SELECT mint,CAST(submitted/3600 AS INTEGER) hour FROM social_posts UNION SELECT mint,CAST(submitted/3600 AS INTEGER)-1 hour FROM social_posts) SELECT DISTINCT hour FROM candidates p WHERE mint=? AND hour>=0 AND hour<=? AND NOT EXISTS(SELECT 1 FROM social_round_plans r WHERE r.mint=p.mint AND r.hour=p.hour) AND NOT EXISTS(SELECT 1 FROM social_empty_rounds r WHERE r.mint=p.mint AND r.hour=p.hour) ORDER BY hour LIMIT 1`).get(mint,eligible);
 if(!candidate)return;
 try{const plan=await social.freeze({program,mint,hour:candidate.hour,budget:fresh.coinFees.toString(),now:Math.min(now,Number(unixTime))});await queueSocialPlan({db,connection,program,plan,unixTime})}
 catch(error){if(error.message!=='empty_distribution')throw error;db.prepare('INSERT OR IGNORE INTO social_empty_rounds VALUES(?,?)').run(mint,candidate.hour)}
}
export function socialBuilder({db,connection,program,genesis,signer}){
 return async job=>{
  if(await connection.getGenesisHash()!==genesis)throw Error('wrong_cluster');
  const b=typeof job.body==='string'?JSON.parse(job.body):job.body;
  if(!Number.isSafeInteger(b.hour)||b.hour<0||!['keeper_social_publish','keeper_social_claim','keeper_social_expire'].includes(job.kind))throw Error('invalid_social_job');
  const plan=loadSocialPlan(db,program,b.mint,b.hour),snapshot=await maintenanceSnapshot(connection,program,b.mint);
  const round=decodeSocialRound(await connection.getAccountInfo(new PublicKey(plan.round),'finalized'),{program,mint:b.mint,hour:b.hour});
  if(round&&(round.root!==plan.root||round.remaining>BigInt(plan.budget)))throw Error('social_round_conflict');
  let ix;
  if(job.kind==='keeper_social_publish'){
   if(round)return {noop:'maintenance_already_satisfied'};
   if(snapshot.launch.coinFees<BigInt(plan.budget))throw Error('social_budget_changed');
   ix=publishSocialRoundInstruction({program,mint:plan.mint,authority:signer.publicKey,hour:BigInt(plan.hour),root:plan.root,budget:plan.budget});
  }else{
   if(!round)throw Error('social_round_missing');
   if(job.kind==='keeper_social_expire'){
    if(snapshot.unixTime<=round.expiresAt)throw Error('social_round_not_expired');
    if(round.remaining===0n)return {noop:'maintenance_already_satisfied'};
    ix=expireSocialRoundInstruction({program,mint:plan.mint,round:plan.round});
   }else{
    const claim=plan.claims.find(c=>c.owner===b.owner);if(!claim)throw Error('social_claim_missing');
    if(paidReceipt(await connection.getAccountInfo(receiptAddress(program,plan.round,claim.owner),'finalized'),{program,round:plan.round,claim})||snapshot.unixTime>round.expiresAt)return {noop:'maintenance_already_satisfied'};
    ix=claimSocialRewardInstruction({program,round:plan.round,payer:signer.publicKey,...claim});
   }
  }
  return signedEnvelope(connection,signer,ix);
 };
}
