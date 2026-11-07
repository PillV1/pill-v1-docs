import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPair,exportSPKI,SignJWT} from 'jose';
import sharp from 'sharp';
import {Identity} from '../services/api/identity.mjs';
import {PrivyIdentity} from '../services/api/privy.mjs';
import {Media} from '../services/api/media.mjs';
function setup(){const db=new DatabaseSync(':memory:'),identity=new Identity(db,'https://pillv1.fun'),now=1800000000;for(const [session,wallet] of [['one','wallet1'],['two','wallet2']])db.prepare('INSERT INTO auth_sessions VALUES(?,?,?)').run(createHash('sha256').update(session).digest('hex'),wallet,now+3600);return {db,identity,now}}
test('Privy verifies issuer, audience, signature, age and immutable X payout binding',async()=>{
 const {db,identity,now}=setup(),keys=await generateKeyPair('ES256'),privy=new PrivyIdentity({identity,appId:'app',verificationKey:await exportSPKI(keys.publicKey)});
 const sign=({aud='app',exp=now+600,subject='123',key=keys.privateKey}={})=>new SignJWT({linked_accounts:JSON.stringify([{type:'twitter_oauth',subject,username:'trader'}])}).setProtectedHeader({alg:'ES256'}).setIssuer('privy.io').setAudience(aud).setSubject('did:privy:abc').setIssuedAt(now).setExpirationTime(exp).sign(key);
 assert.equal((await privy.link('one',await sign(),now)).xId,'123');
 await assert.rejects(privy.link('two',await sign(),now),/x_already_linked/);
 await assert.rejects(privy.link('one',await sign({subject:'456'}),now),/x_already_linked/);
 await assert.rejects(privy.link('one',await sign({aud:'other'}),now),/invalid_privy/);
 await assert.rejects(privy.link('one',await sign({exp:now-1}),now),/invalid_privy/);
 await assert.rejects(privy.link('one',await sign({key:(await generateKeyPair('ES256')).privateKey}),now),/invalid_privy/);
 await assert.rejects(privy.link('invalid',await sign(),now),/unauthenticated/);db.close();
});
test('media publishes immutable sanitized images and metadata, rejects hostile files and enforces quota',async()=>{
 const {db,identity,now}=setup(),directory=await mkdtemp(join(tmpdir(),'pill-media-')),media=new Media({identity,directory,origin:'https://pillv1.fun'});
 try{
  const image=(await sharp({create:{width:3,height:3,channels:3,background:'#a4f5c4'}}).png().toBuffer()).toString('base64'),input={name:'Pill',symbol:'PILL',description:'Hello',twitter:'https://x.com/pill',telegram:'https://t.me/pill',website:'https://pillv1.fun',image};
  const result=await media.publish('one',input,now),again=await media.publish('one',input,now);assert.equal(result.uri,again.uri);
  const doc=JSON.parse((await media.get(result.uri.split('/').at(-1))).bytes);assert.equal(doc.image,result.image);assert.equal(doc.twitter,input.twitter);assert.equal(doc.telegram,input.telegram);assert.equal(doc.website,'https://pillv1.fun/');
  for(const website of ['javascript:alert(1)','http://unsafe.test','https://user:pass@example.com'])await assert.rejects(media.publish('one',{...input,website},now),/invalid_social_link/);
  await assert.rejects(media.publish('one',{...input,twitter:'https://wrong.test'},now),/invalid_social_link/);
  assert.equal((await sharp((await media.get(result.image.split('/').at(-1))).bytes).metadata()).format,'webp');
  await assert.rejects(media.publish('invalid',input,now),/unauthenticated/);
  await assert.rejects(media.publish('one',{...input,image:Buffer.from('<svg onload="alert(1)"/>').toString('base64')},now));
  await assert.rejects(media.get('../secret'),/media_not_found/);
  for(let i=0;i<8;i++)await media.publish('one',input,now);
  await assert.rejects(media.publish('one',input,now),/upload_rate_limit/);
 }finally{db.close();await rm(directory,{recursive:true,force:true})}
});
