import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {integer} from '../../sdk/src/quotes.mjs';
import {rewardTree,socialRoundAddress} from '../../sdk/src/social-rewards.mjs';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const metric=(metrics,name)=>{const n=metrics?.[name];if(!Number.isSafeInteger(n)||n<0)throw Error('invalid_x_metrics');return Math.min(n,1000)};
// Independent published v1 policy; Fun's private scoring formula is not public.
export function scorePosts({posts,links,holdings,mint,hour}){
 if(!Number.isSafeInteger(hour)||hour<0)throw Error('invalid_hour');mint=new PublicKey(mint).toBase58();
 const owners=new Map(links.map(l=>[l.x_id,l.wallet]));if(owners.size!==links.length)throw Error('duplicate_x_identity');
 const seen=new Set(),contents=new Set(),byWallet=new Map();
 for(const p of [...posts].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||String(a.id).localeCompare(String(b.id)))){
  if(typeof p.text!=='string'||!new RegExp(`(^|[^1-9A-HJ-NP-Za-km-z])${mint}($|[^1-9A-HJ-NP-Za-km-z])`).test(p.text))continue;
  const time=Date.parse(p.created_at)/1000;if(!Number.isFinite(time)||time<hour*3600||time>=(hour+1)*3600)continue;
  if(p.referenced_tweets?.some(r=>r.type==='retweeted'))continue;
  const wallet=owners.get(p.author_id);if(!wallet||integer(holdings[wallet]??'0')===0n)continue;
  const original=p.edit_history_tweet_ids?.[0]??p.id,content=digest(p.text.trim().replace(/\s+/g,' ').toLowerCase());
  if(seen.has(original)||contents.has(content))continue;seen.add(original);contents.add(content);
  const score=1+metric(p.public_metrics,'like_count')+3*metric(p.public_metrics,'retweet_count')+2*metric(p.public_metrics,'reply_count')+3*metric(p.public_metrics,'quote_count');
  const entries=byWallet.get(wallet)??[];if(entries.length<3){entries.push({id:p.id,score});byWallet.set(wallet,entries)}
 }
 return [...byWallet].map(([owner,posts])=>({owner,score:posts.reduce((n,p)=>n+BigInt(p.score),0n),posts:posts.map(p=>p.id)})).sort((a,b)=>a.owner<b.owner?-1:1);
}
export function allocateRewards(scores,budget){
 budget=integer(budget);if(!scores.length||budget===0n)throw Error('empty_distribution');
 if(new Set(scores.map(s=>s.owner)).size!==scores.length||scores.some(s=>typeof s.score!=='bigint'||s.score<=0n))throw Error('invalid_scores');
 const total=scores.reduce((n,s)=>n+s.score,0n);let used=0n;
 const rows=scores.map(s=>{const n=budget*s.score,amount=n/total;used+=amount;return {...s,amount,remainder:n%total}});
 rows.sort((a,b)=>a.remainder===b.remainder?(a.owner<b.owner?-1:1):(a.remainder>b.remainder?-1:1));
 for(let i=0;used<budget;i++,used++)rows[i].amount++;
 return rows.filter(r=>r.amount>0n).map(r=>({owner:r.owner,amount:r.amount.toString()}));
}
export class Social {
 constructor(db,identity,xClient,holderReader){
  Object.assign(this,{db,identity,xClient,holderReader});db.exec(`
   CREATE TABLE IF NOT EXISTS social_posts(mint TEXT NOT NULL,post_id TEXT NOT NULL,wallet TEXT NOT NULL,submitted INTEGER NOT NULL,PRIMARY KEY(mint,post_id));
   CREATE TABLE IF NOT EXISTS social_verified_posts(mint TEXT NOT NULL,post_id TEXT NOT NULL,wallet TEXT NOT NULL,hour INTEGER NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(mint,post_id));
   CREATE TABLE IF NOT EXISTS social_round_plans(mint TEXT NOT NULL,hour INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(mint,hour));`);
 }
 submit(session,mint,postId,now){
  const user=this.identity.session(session,now);mint=new PublicKey(mint).toBase58();
  if(!/^[0-9]{1,30}$/.test(postId)||!this.db.prepare('SELECT 1 FROM x_links WHERE wallet=?').get(user.wallet))throw Error('linked_x_required');
  if(this.db.prepare('SELECT COUNT(*) n FROM social_posts WHERE wallet=? AND submitted>?').get(user.wallet,now-3600).n>=10)throw Error('post_rate_limit');
  this.db.prepare('INSERT OR IGNORE INTO social_posts VALUES(?,?,?,?)').run(mint,postId,user.wallet,now);return {status:'submitted_for_verification'};
 }
 raids(mint,{before=Number.MAX_SAFE_INTEGER,limit=50}={}){
  mint=new PublicKey(mint).toBase58();if(!Number.isSafeInteger(before)||before<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_pagination');
  const rows=this.db.prepare('SELECT rowid id,post_id postId,wallet,hour,verified_at verifiedAt FROM social_verified_posts WHERE mint=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(mint,before,limit);
  return {items:rows.map(r=>({...r,url:`https://x.com/i/status/${r.postId}`})),nextBefore:rows.length===limit?rows.at(-1).id:null,verification:'linked_author_and_holder_at_round_freeze'};
 }
 proofs(program,mint,owner,{before=Number.MAX_SAFE_INTEGER,limit=20}={}){
  mint=new PublicKey(mint).toBase58();owner=new PublicKey(owner).toBase58();program=new PublicKey(program).toBase58();
  if(!Number.isSafeInteger(before)||before<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_pagination');
  const rows=this.db.prepare('SELECT body,hash,hour FROM social_round_plans WHERE mint=? AND hour<? ORDER BY hour DESC LIMIT ?').all(mint,before,limit);
  const items=[];for(const row of rows){if(digest(JSON.parse(row.body))!==row.hash)throw Error('social_plan_integrity');const p=JSON.parse(row.body);if(p.program!==program)throw Error('round_program_mismatch');const claim=p.claims.find(c=>c.owner===owner);if(claim)items.push({program,mint,hour:p.hour,round:p.round,root:p.root,...claim})}
  return {items,nextBefore:rows.length===limit?rows.at(-1).hour:null,status:'frozen_plan_check_onchain_round_before_claim'};
 }
 // Private operator method. No caller-supplied scores, wallet balances or X metrics.
 async freeze({program,mint,hour,budget,now}){
  if(!Number.isSafeInteger(hour)||hour<0||now<(hour+1)*3600+1800)throw Error('round_not_ready');mint=new PublicKey(mint).toBase58();
  const old=this.db.prepare('SELECT body FROM social_round_plans WHERE mint=? AND hour=?').get(mint,hour);if(old){const saved=JSON.parse(old.body);if(saved.program!==new PublicKey(program).toBase58())throw Error('round_program_mismatch');return saved;}
  const submissions=this.db.prepare('SELECT post_id,wallet FROM social_posts WHERE mint=? AND submitted>=? AND submitted<=? ORDER BY post_id LIMIT 10001').all(mint,hour*3600,(hour+1)*3600+1800);
  if(submissions.length>10000)throw Error('round_too_large');
  const links=this.db.prepare('SELECT * FROM x_links').all(),posts=[];
  for(let i=0;i<submissions.length;i+=100)posts.push(...await this.xClient.posts(submissions.slice(i,i+100).map(s=>s.post_id)));
  const submitted=new Map(submissions.map(s=>[s.post_id,s.wallet])),author=new Map(links.map(l=>[l.x_id,l.wallet]));
  const verified=posts.filter(p=>submitted.has(p.id)&&author.has(p.author_id)&&submitted.get(p.id)===author.get(p.author_id));
  const eligible=[...new Set(verified.map(p=>author.get(p.author_id)))];
  const observations=await this.holderReader({program,mint,wallets:eligible});
  if(observations.length!==eligible.length||new Set(observations.map(o=>o.wallet)).size!==eligible.length||observations.some(o=>!eligible.includes(o.wallet)))throw Error('incomplete_holder_observations');
  const holdings=Object.fromEntries(observations.map(o=>[o.wallet,integer(o.balance).toString()]));
  const scores=scorePosts({posts:verified,links,holdings,mint,hour});const allocation=allocateRewards(scores,budget);
  const round=socialRoundAddress(program,mint,BigInt(hour));
  const plan={policy:'engagement-v1',program:new PublicKey(program).toBase58(),mint,hour,round:round.toBase58(),...rewardTree(round,allocation),evidenceHash:digest({posts:verified,observations,links}),observedAt:now};
  const encoded=JSON.stringify(plan);this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare('INSERT INTO social_round_plans VALUES(?,?,?,?,?)').run(mint,hour,encoded,digest(plan),now);
   for(const score of scores)for(const id of score.posts)this.db.prepare('INSERT OR IGNORE INTO social_verified_posts VALUES(?,?,?,?,?)').run(mint,id,score.owner,hour,now);
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error}return plan;
 }
}
