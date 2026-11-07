import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {Keypair} from '@solana/web3.js';import {TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';import {Profiles} from '../services/api/profiles.mjs';
test('profile balances only include Pill mints and private replies require the owner session',async()=>{
 const db=new DatabaseSync(':memory:'),owner=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,program=Keypair.generate().publicKey;
 db.exec('CREATE TABLE coins(mint TEXT,launch TEXT,creator TEXT,symbol TEXT,phase TEXT,version INTEGER,created_slot INTEGER);CREATE TABLE x_links(wallet TEXT,username TEXT);CREATE TABLE discussions(id INTEGER,text TEXT,created INTEGER,mint TEXT,wallet TEXT,hidden INTEGER)');db.prepare('INSERT INTO coins VALUES(?,?,?,?,?,?,?)').run(mint.toBase58(),'launch',owner.toBase58(),'PILL','curve',1,1);db.prepare('INSERT INTO discussions VALUES(?,?,?,?,?,?)').run(1,'hello',1000,mint.toBase58(),owner.toBase58(),0);
 const token=m=>({account:{data:{parsed:{info:{mint:m,owner:owner.toBase58(),tokenAmount:{amount:'1000000'}}}}}});
 const connection={getParsedTokenAccountsByOwner:async(_,filter)=>({context:{slot:10},value:filter.programId.equals(TOKEN_2022_PROGRAM_ID)?[]:[token(mint.toBase58()),token(Keypair.generate().publicKey.toBase58())]}),getProgramAccounts:async()=>({context:{slot:10},value:[]})};
 const identity={session:s=>{if(s==='owner')return {wallet:owner.toBase58()};if(s==='other')return {wallet:'other'};throw Error('unauthenticated')}};
 const service=new Profiles({db,connection,identity,program});const publicData=await service.read(owner,null,1000);assert.equal(publicData.replies,null);assert.equal(publicData.held.length,1);assert.equal(publicData.held[0].balanceRaw,'1000000');assert.equal((await service.read(owner,'other',1000)).replies,null);assert.equal((await service.read(owner,'owner',1000)).replies[0].text,'hello');db.close();
});
test('profile edits are owner-bound, bounded, unique ignoring case, and public identity reads need no RPC',()=>{
 const db=new DatabaseSync(':memory:'),owner=Keypair.generate().publicKey.toBase58(),other=Keypair.generate().publicKey.toBase58();db.exec('CREATE TABLE x_links(wallet TEXT,username TEXT)');
 const identity={session:s=>{if(s==='owner')return {wallet:owner};if(s==='other')return {wallet:other};throw Error('unauthenticated')}};
 const service=new Profiles({db,connection:{},identity,program:Keypair.generate().publicKey});
 assert.throws(()=>service.update(null,{username:'Trader'},100),/unauthenticated/);
 assert.throws(()=>service.update('other',{wallet:owner,username:'Trader'},100),/profile_owner_required/);
 for(const username of ['','a'.repeat(21),'<script>','a b'])assert.throws(()=>service.update('owner',{username},100),/profile_name_invalid/);
 assert.throws(()=>service.update('owner',{username:'Trader',avatar:'https://evil.example/avatar.svg'},100),/invalid_image/);
 const avatar='/media/'+'a'.repeat(64)+'.webp';service.update('owner',{username:'Trader',avatar},100);
 assert.throws(()=>service.update('other',{username:'trader'},101),/profile_name_taken/);
 assert.throws(()=>service.update('owner',{username:'Changed'},101),/profile_update_rate_limit/);
 assert.deepEqual(service.publicBatch([owner,owner]).profiles,[{wallet:owner,username:'Trader',avatar}]);
 service.update('owner',{username:'Changed',avatar:null},111);assert.equal(service.publicBatch([owner]).profiles[0].avatar,null);
 assert.throws(()=>service.publicBatch(Array(101).fill(owner)),/invalid_profile_batch/);db.close();
});
test('native Pump profile balances use Token-2022 token accounts',async()=>{
 const db=new DatabaseSync(':memory:'),owner=Keypair.generate().publicKey,mint=Keypair.generate().publicKey;
 db.exec('CREATE TABLE coins(mint TEXT,launch TEXT,creator TEXT,symbol TEXT,phase TEXT,version INTEGER,created_slot INTEGER)');db.prepare('INSERT INTO coins VALUES(?,?,?,?,?,?,?)').run(mint.toBase58(),'launch',owner.toBase58(),'NEW','curve',2,1);
 const seen=[];const connection={getParsedTokenAccountsByOwner:async(_,filter)=>{seen.push(filter.programId.toBase58());return {context:{slot:10},value:filter.programId.equals(TOKEN_2022_PROGRAM_ID)?[{account:{data:{parsed:{info:{mint:mint.toBase58(),owner:owner.toBase58(),tokenAmount:{amount:'321'}}}}}}]:[]}},getProgramAccounts:async()=>({context:{slot:10},value:[]})};
 const service=new Profiles({db,connection,identity:{},program:Keypair.generate().publicKey});const held=await service.snapshot(owner);assert.equal(held[0].balanceRaw,'321');assert.equal(held[0].version,2);assert(seen.includes(TOKEN_2022_PROGRAM_ID.toBase58()));db.close();
});
