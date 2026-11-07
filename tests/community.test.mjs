import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {Keypair} from '@solana/web3.js';import {Community} from '../services/api/community.mjs';
test('discussions preserve text, paginate, rate-limit and require auditable moderator authority',()=>{
 const db=new DatabaseSync(':memory:'),mint=Keypair.generate().publicKey.toBase58(),wallet=Keypair.generate().publicKey.toBase58(),moderator=Keypair.generate().publicKey.toBase58();db.exec('CREATE TABLE coins(mint TEXT PRIMARY KEY)');db.prepare('INSERT INTO coins VALUES(?)').run(mint);
 const identity={session:s=>{if(![wallet,moderator].includes(s))throw Error('unauthenticated');return {wallet:s}}},service=new Community(db,identity,{moderators:[moderator]});
 const p=service.post(wallet,{mint,text:'<b>This is plain text</b>'},1000);assert.equal(p.text,'<b>This is plain text</b>');
 for(let i=0;i<4;i++)service.post(wallet,{mint,text:'message '+i},1000);
 assert.throws(()=>service.post(wallet,{mint,text:'too fast'},1001),/rate_limit/);
 const page=service.list(mint,{limit:2}),next=service.list(mint,{limit:2,before:page.next});assert.equal(new Set([...page.posts,...next.posts].map(p=>p.id)).size,4);
 assert.throws(()=>service.moderate(wallet,{id:p.id,hidden:true,reason:'spam'},1002),/moderator_required/);
 service.report(wallet,{id:p.id,reason:'spam'},1002);service.report(wallet,{id:p.id,reason:'again'},1003);assert.equal(db.prepare('SELECT count(*) n FROM post_reports').get().n,1);
 service.moderate(moderator,{id:p.id,hidden:true,reason:'spam'},1003);assert(!service.list(mint).posts.some(x=>x.id===p.id));assert.equal(db.prepare('SELECT count(*) n FROM moderation_actions').get().n,1);
 service.moderate(moderator,{id:p.id,hidden:false,reason:'restored'},1004);assert(service.list(mint).posts.some(x=>x.id===p.id));db.close();
});
test('reply images are constrained to hosted media and likes are owner-bound/idempotent',()=>{
 const db=new DatabaseSync(':memory:'),mint=Keypair.generate().publicKey.toBase58(),a=Keypair.generate().publicKey.toBase58(),b=Keypair.generate().publicKey.toBase58();db.exec('CREATE TABLE coins(mint TEXT PRIMARY KEY)');db.prepare('INSERT INTO coins VALUES(?)').run(mint);
 const identity={session:s=>{if(![a,b].includes(s))throw Error('unauthenticated');return {wallet:s}}},service=new Community(db,identity,{moderators:[a]});
 const image='/media/'+'a'.repeat(64)+'.webp',p=service.post(a,{mint,text:'',image},1000);
 assert.equal(service.list(mint).posts[0].image,image);
 for(const image of ['https://tracker.invalid/a.webp','javascript:alert(1)','/media/../../etc/passwd'])assert.throws(()=>service.post(a,{mint,text:'test',image},1001),/invalid_image/);
 assert.throws(()=>service.like('bad',{id:p.id,liked:true},1001),/unauthenticated/);
 service.like(a,{id:p.id,liked:true},1001);service.like(a,{id:p.id,liked:true},1002);service.like(b,{id:p.id,liked:true},1003);
 assert.equal(service.list(mint,{},a,1004).posts[0].liked,1);assert.equal(service.list(mint).posts[0].likes,2);
 service.like(a,{id:p.id,liked:false},1004);assert.equal(service.list(mint,{},a,1005).posts[0].liked,0);assert.equal(service.list(mint).posts[0].likes,1);
 service.moderate(a,{id:p.id,hidden:true,reason:'moderation'},1006);assert.throws(()=>service.like(b,{id:p.id,liked:true},1007),/post_not_found/);db.close();
});
