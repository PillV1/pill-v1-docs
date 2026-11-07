import {PublicKey} from '@solana/web3.js';
// Text remains plain data. Clients must render with textContent, never HTML.
export class Community {
 constructor(db,identity,{moderators=[]}={}){
  Object.assign(this,{db,identity});this.moderators=new Set(moderators.map(x=>new PublicKey(x).toBase58()));
  db.exec(`CREATE TABLE IF NOT EXISTS discussions(id INTEGER PRIMARY KEY AUTOINCREMENT,mint TEXT NOT NULL,wallet TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL,hidden INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS discussions_page ON discussions(mint,id DESC);
  CREATE INDEX IF NOT EXISTS discussions_rate ON discussions(wallet,created);
  CREATE TABLE IF NOT EXISTS moderation_actions(id INTEGER PRIMARY KEY AUTOINCREMENT,post INTEGER NOT NULL,moderator TEXT NOT NULL,hidden INTEGER NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS discussion_likes(post INTEGER NOT NULL,wallet TEXT NOT NULL,PRIMARY KEY(post,wallet));
  CREATE TABLE IF NOT EXISTS post_reports(post INTEGER NOT NULL,wallet TEXT NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(post,wallet));`);
  if(!db.prepare('PRAGMA table_info(discussions)').all().some(c=>c.name==='image'))db.exec('ALTER TABLE discussions ADD COLUMN image TEXT');
 }
 coin(mint){mint=new PublicKey(mint).toBase58();if(!this.db.prepare('SELECT 1 FROM coins WHERE mint=?').get(mint)){const exists=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='onepill_launches'").get()&&this.db.prepare("SELECT 1 FROM onepill_launches WHERE state='done' AND json_extract(coin,'$.chains.solana.token')=?").get(mint);if(!exists)throw Error('coin_not_found');}return mint}
 post(session,{mint,text,image=null},now){
  const user=this.identity.session(session,now);mint=this.coin(mint);
  if(image!==null&&(typeof image!=='string'||!/^\/media\/[a-f0-9]{64}\.webp$/.test(image)))throw Error('invalid_image');
  if(typeof text!=='string'||(!text.trim()&&!image)||Buffer.byteLength(text)>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw Error('invalid_message');
  if(this.db.prepare('SELECT COUNT(*) n FROM discussions WHERE wallet=? AND created>?').get(user.wallet,now-60).n>=5)throw Error('discussion_rate_limit');
  const row=this.db.prepare('INSERT INTO discussions(mint,wallet,text,created,image) VALUES(?,?,?,?,?) RETURNING id,mint,wallet,text,created,image').get(mint,user.wallet,text.trim(),now,image);return row;
 }
 list(mint,{before=Number.MAX_SAFE_INTEGER,limit=50}={},session=null,now=0){
  mint=this.coin(mint);if(!Number.isSafeInteger(before)||before<1||!Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_pagination');
  let viewer='';if(session){try{viewer=this.identity.session(session,now).wallet}catch(e){if(e.message!=='unauthenticated')throw e}}
  const rows=this.db.prepare('SELECT id,mint,wallet,text,created,image,(SELECT COUNT(*) FROM discussion_likes WHERE post=discussions.id) AS likes,EXISTS(SELECT 1 FROM discussion_likes WHERE post=discussions.id AND wallet=?) AS liked FROM discussions WHERE mint=? AND hidden=0 AND id<? ORDER BY id DESC LIMIT ?').all(viewer,mint,before,limit+1),more=rows.length>limit;rows.length=Math.min(rows.length,limit);return {posts:rows,next:more?rows.at(-1).id:null};
 }
 like(session,{id,liked},now){
  const user=this.identity.session(session,now);
  if(!Number.isSafeInteger(id)||id<1||typeof liked!=='boolean')throw Error('invalid_like');
  if(!this.db.prepare('SELECT 1 FROM discussions WHERE id=? AND hidden=0').get(id))throw Error('post_not_found');
  if(liked)this.db.prepare('INSERT OR IGNORE INTO discussion_likes VALUES(?,?)').run(id,user.wallet);
  else this.db.prepare('DELETE FROM discussion_likes WHERE post=? AND wallet=?').run(id,user.wallet);
  return {id,liked,likes:this.db.prepare('SELECT COUNT(*) n FROM discussion_likes WHERE post=?').get(id).n};
 }
 report(session,{id,reason},now){
  const user=this.identity.session(session,now);this.validReason(id,reason);
  if(!this.db.prepare('SELECT 1 FROM discussions WHERE id=?').get(id))throw Error('post_not_found');
  this.db.prepare('INSERT OR IGNORE INTO post_reports VALUES(?,?,?,?)').run(id,user.wallet,reason,now);return {reported:true};
 }
 validReason(id,reason){if(!Number.isSafeInteger(id)||id<1||typeof reason!=='string'||!reason.trim()||Buffer.byteLength(reason)>500)throw Error('invalid_report')}
 moderate(session,{id,hidden,reason},now){
  const user=this.identity.session(session,now);if(!this.moderators.has(user.wallet))throw Error('moderator_required');this.validReason(id,reason);if(typeof hidden!=='boolean')throw Error('invalid_moderation');
  this.db.exec('BEGIN IMMEDIATE');try{
   if(!this.db.prepare('UPDATE discussions SET hidden=? WHERE id=?').run(Number(hidden),id).changes)throw Error('post_not_found');
   this.db.prepare('INSERT INTO moderation_actions(post,moderator,hidden,reason,created) VALUES(?,?,?,?,?)').run(id,user.wallet,Number(hidden),reason,now);this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e}return {id,hidden};
 }
}
