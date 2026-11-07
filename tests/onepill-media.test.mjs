import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {Media} from '../services/api/media.mjs';
test('OnePill uploads sanitized image then IPFS metadata, with server-only authorization',async()=>{
 const db=new DatabaseSync(':memory:'),directory=await mkdtemp(join(tmpdir(),'pill-media-')),calls=[];
 const cid='bafy'+'a'.repeat(50),media=new Media({identity:{db,session:()=>({wallet:'test'})},directory,origin:'https://pillv1.fun',pinataJwt:'test-secret',fetcher:async(url,options)=>{calls.push({url,options});return Response.json({data:{cid}})}});
 try{const image=await sharp({create:{width:4,height:4,channels:3,background:'#00ff00'}}).png().toBuffer();
 const result=await media.publish('session',{name:'Test',symbol:'TEST',description:'test',image:image.toString('base64')},1000,true);
 assert.equal(result.uri,'ipfs://'+cid);assert.equal(calls.length,2);assert.equal(calls[0].options.body.get('network'),'public');assert.equal(calls[0].options.body.get('file').type,'image/webp');
 const metadata=JSON.parse(await calls[1].options.body.get('file').text());assert.equal(metadata.image,'ipfs://'+cid);assert.equal(metadata.symbol,'TEST');assert.equal(JSON.stringify(result).includes('test-secret'),false);
 media.pinataJwt='';await assert.rejects(()=>media.publish('session',{},1000,true),/not_configured/);
 }finally{db.close();await rm(directory,{recursive:true,force:true})}
});
