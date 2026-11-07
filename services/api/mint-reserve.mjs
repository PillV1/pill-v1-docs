import {DatabaseSync} from 'node:sqlite';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
export class MintReserve {
 constructor({database,key,identity}) {
  if(key.length!==32)throw Error('invalid_reserve_key');
  this.key=key;this.identity=identity;this.db=new DatabaseSync(database);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS mint_reserve(mint TEXT PRIMARY KEY, sealed BLOB NOT NULL, owner TEXT, request TEXT UNIQUE, assigned INTEGER);
   CREATE INDEX IF NOT EXISTS mint_reserve_owner ON mint_reserve(owner,assigned);`);
 }
 add(secret){const pair=Keypair.fromSecretKey(Uint8Array.from(secret)),mint=pair.publicKey.toBase58();if(!mint.endsWith('piLL'))throw Error('invalid_mint_suffix');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(mint));
  const bytes=Buffer.concat([cipher.update(pair.secretKey),cipher.final()]);
  this.db.prepare('INSERT INTO mint_reserve(mint,sealed) VALUES(?,?)').run(mint,Buffer.concat([iv,cipher.getAuthTag(),bytes]));return mint;
 }
 available(){return this.db.prepare('SELECT COUNT(*) n FROM mint_reserve WHERE owner IS NULL').get().n}
 claim(session,request,now){const {wallet}=this.identity.session(session,now);
  if(!/^[a-zA-Z0-9_-]{16,64}$/.test(request??''))throw Error('invalid_request_id');
  this.db.exec('BEGIN IMMEDIATE');let row;
  try{row=this.db.prepare('SELECT * FROM mint_reserve WHERE request=?').get(request);
   if(row&&row.owner!==wallet)throw Error('unauthenticated');
   if(!row){
    if(this.db.prepare('SELECT COUNT(*) n FROM mint_reserve WHERE owner=? AND assigned>?').get(wallet,now-86400).n>=3)throw Error('mint_reservation_limit');
    row=this.db.prepare('SELECT * FROM mint_reserve WHERE owner IS NULL LIMIT 1').get();
    if(!row)throw Error('mint_reserve_replenishing');
    this.db.prepare('UPDATE mint_reserve SET owner=?,request=?,assigned=? WHERE mint=? AND owner IS NULL').run(wallet,request,now,row.mint);
   }
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error}
  const sealed=Buffer.from(row.sealed),decipher=createDecipheriv('aes-256-gcm',this.key,sealed.subarray(0,12));decipher.setAuthTag(sealed.subarray(12,28));decipher.setAAD(Buffer.from(row.mint));
  const secret=Buffer.concat([decipher.update(sealed.subarray(28)),decipher.final()]);
  const result={mint:row.mint,secretKey:[...secret]};secret.fill(0);return result;
 }
}
