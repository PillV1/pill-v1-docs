import {randomBytes,createHash,createPublicKey,verify} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
const digest=v=>createHash('sha256').update(v).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
// db is a private node:sqlite DatabaseSync. Persist only session hashes.
export class Identity {
 constructor(db,origin){
  const url=new URL(origin);if(url.protocol!=='https:'&&url.hostname!=='localhost')throw Error('https_origin_required');
  this.db=db;this.origin=url.origin;
  db.exec(`CREATE TABLE IF NOT EXISTS auth_challenges(id TEXT PRIMARY KEY,wallet TEXT NOT NULL,message TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS auth_sessions(hash TEXT PRIMARY KEY,wallet TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY,session_hash TEXT NOT NULL,wallet TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS x_links(wallet TEXT PRIMARY KEY,x_id TEXT NOT NULL UNIQUE,username TEXT NOT NULL,linked_at INTEGER NOT NULL);`);
 }
 challenge(wallet,now){
  wallet=new PublicKey(wallet).toBase58();this.db.prepare('DELETE FROM auth_challenges WHERE expires<?').run(now);
  if(this.db.prepare('SELECT COUNT(*) n FROM auth_challenges WHERE wallet=?').get(wallet).n>=5)throw Error('challenge_rate_limit');
  const id=token(),expires=now+300,message=`${this.origin}\nAuthenticate wallet: ${wallet}\nNonce: ${id}\nExpires: ${expires}\nThis signature does not authorize a transaction.`;
  this.db.prepare('INSERT INTO auth_challenges VALUES(?,?,?,?)').run(id,wallet,message,expires);return {id,message,expires};
 }
 authenticate(id,signature,now){
  const row=this.db.prepare('SELECT * FROM auth_challenges WHERE id=? AND expires>=?').get(id,now);
  if(!row||typeof signature!=='string'||signature.length>100)throw Error('invalid_challenge');
  const bytes=Buffer.from(signature,'base64');if(bytes.length!==64||bytes.toString('base64')!==signature)throw Error('invalid_signature');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(row.wallet).toBuffer()]),format:'der',type:'spki'});
  if(!verify(null,Buffer.from(row.message),key,bytes))throw Error('invalid_signature');
  const session=token();this.db.exec('BEGIN IMMEDIATE');
  try{if(this.db.prepare('DELETE FROM auth_challenges WHERE id=?').run(id).changes!==1)throw Error('challenge_replayed');this.db.prepare('INSERT INTO auth_sessions VALUES(?,?,?)').run(digest(session),row.wallet,now+3600);this.db.exec('COMMIT')}catch(e){this.db.exec('ROLLBACK');throw e}
  return {session,wallet:row.wallet,expires:now+3600};
 }
 session(value,now){if(typeof value!=='string'||value.length>100)throw Error('unauthenticated');const row=this.db.prepare('SELECT * FROM auth_sessions WHERE hash=? AND expires>=?').get(digest(value),now);if(!row)throw Error('unauthenticated');return row}
 logout(value){this.db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(digest(value))}
 beginX(session,client,now){
  const user=this.session(session,now),state=token(),verifier=token();
  this.db.prepare('DELETE FROM oauth_states WHERE expires<?').run(now);
  this.db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?,?)').run(state,user.hash,user.wallet,verifier,now+300);
  return client.authorizationUrl(state,createHash('sha256').update(verifier).digest('base64url'));
 }
 async finishX(session,state,code,client,now){
  const user=this.session(session,now);
  const row=this.db.prepare('DELETE FROM oauth_states WHERE state=? AND session_hash=? AND expires>=? RETURNING *').get(state,user.hash,now);
  if(!row)throw Error('invalid_oauth_state');
  const profile=await client.identify(code,row.verifier);
  if(!/^[0-9]{1,30}$/.test(profile.id)||typeof profile.username!=='string'||profile.username.length>64)throw Error('invalid_x_identity');
  this.db.prepare('INSERT INTO x_links VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET x_id=excluded.x_id,username=excluded.username,linked_at=excluded.linked_at').run(user.wallet,profile.id,profile.username,now);
  return {wallet:user.wallet,xId:profile.id,username:profile.username};
 }
}
