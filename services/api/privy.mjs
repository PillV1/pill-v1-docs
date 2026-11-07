import {importSPKI,jwtVerify} from 'jose';

// A signed wallet session and a verified Privy identity are both required.
// Stable X IDs cannot be moved between payout wallets by relinking a username.
export class PrivyIdentity {
 constructor({identity,appId,verificationKey}) {
  this.identity=identity;this.appId=appId;
  this.key=importSPKI(verificationKey.replace(/\\n/g,'\n'),'ES256');
 }
 async link(session,token,now) {
  const user=this.identity.session(session,now);
  if(typeof token!=='string'||token.length>24000)throw Error('invalid_privy_identity');
  let payload;
  try {
   ({payload}=await jwtVerify(token,await this.key,{algorithms:['ES256'],issuer:'privy.io',audience:this.appId,
    requiredClaims:['exp','iat','sub','linked_accounts'],currentDate:new Date(now*1000),maxTokenAge:'1h'}));
   if(typeof payload.sub!=='string'||!payload.sub.startsWith('did:privy:'))throw Error();
  } catch {throw Error('invalid_privy_identity')}
  let accounts;try{accounts=JSON.parse(payload.linked_accounts)}catch{throw Error('invalid_privy_identity')}
  if(!Array.isArray(accounts))throw Error('invalid_privy_identity');
  const x=accounts.filter(a=>a.type==='twitter_oauth');
  if(x.length!==1||!/^\d{1,30}$/.test(x[0].subject)||!/^\w{1,15}$/.test(x[0].username??''))throw Error('x_link_required');
  const db=this.identity.db;db.exec('BEGIN IMMEDIATE');
  try {
   const previous=db.prepare('SELECT * FROM x_links WHERE wallet=? OR x_id=?').all(user.wallet,x[0].subject);
   if(previous.some(p=>p.wallet!==user.wallet||p.x_id!==x[0].subject))throw Error('x_already_linked');
   db.prepare('INSERT INTO x_links VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET username=excluded.username,linked_at=excluded.linked_at').run(user.wallet,x[0].subject,x[0].username,now);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  return {wallet:user.wallet,xId:x[0].subject,username:x[0].username};
 }
}
