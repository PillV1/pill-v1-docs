import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {application} from '../services/api/application.mjs';
function request(server,{path='/',method='GET',headers={},data,remote='127.0.0.1'}={}){return new Promise((resolve,reject)=>{
 const req=Readable.from(data===undefined?[]:[Buffer.from(JSON.stringify(data))]);Object.assign(req,{url:path,method,headers,socket:{remoteAddress:remote}});
 const res={headersSent:false,writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true},end(raw){resolve({status:this.status,headers:this.headers,body:JSON.parse(raw)})}};
 try{server.emit('request',req,res)}catch(e){reject(e)}
})}
test('API rejects cross-origin writes, protects status access and never returns internal error text',async()=>{
 const server=application({origin:'https://launch.test',identity:{challenge:wallet=>({wallet}),logout:()=>{}},launches:{enabled:false,status:(id,token)=>{if(token!=='secret')throw Error('intent_not_found');return {id}},create:()=>{throw Error('private key path should not appear')}},clock:()=>1000});
 const denied=await request(server,{path:'/auth/challenge',method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},data:{wallet:'x'}});assert.equal(denied.status,403);
 const bad=await request(server,{path:'/launch/intents',method:'POST',headers:{'content-type':'application/json'},data:{}});assert.equal(bad.body.error,'request_failed');
 const path='/launch/intents/'+'a'.repeat(48);assert.equal((await request(server,{path})).status,400);assert.equal((await request(server,{path,headers:{authorization:'Bearer secret'}})).status,200);
 assert.equal((await request(server,{path:'/health'})).body.readyForFunds,false);server.close();
});
test('rate limits distinguish users only behind explicitly trusted loopback proxy',async()=>{
 const options={origin:'https://launch.test',launches:{enabled:false},clock:()=>1000};
 const server=application({...options,trustedLoopbackProxy:true});
 for(let i=0;i<300;i++)assert.equal((await request(server,{path:'/health',headers:{'x-real-ip':'192.0.2.1'}})).status,200);
 assert.equal((await request(server,{path:'/health',headers:{'x-real-ip':'192.0.2.1'}})).status,429);
 assert.equal((await request(server,{path:'/health',headers:{'x-real-ip':'192.0.2.2'}})).status,200);
 const untrusted=application(options);
 for(let i=0;i<300;i++)await request(untrusted,{path:'/health',headers:{'x-real-ip':`192.0.2.${i%250+1}`}});
 assert.equal((await request(untrusted,{path:'/health',headers:{'x-real-ip':'198.51.100.1'}})).status,429);server.close();untrusted.close();
});
