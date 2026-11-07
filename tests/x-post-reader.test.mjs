import test from 'node:test';
import assert from 'node:assert/strict';
import {XClient,XPostReader} from '../services/api/x-client.mjs';
test('Privy-linked raids can verify posts with read credentials only, without a second OAuth application',async()=>{
 let called=0;
 const reader=new XPostReader({bearerToken:'test-token',fetchImpl:async(url,options)=>{called++;assert.equal(options.headers.Authorization,'Bearer test-token');assert.equal(new URL(url).hostname,'api.x.com');return new Response(JSON.stringify({data:[{id:'123',author_id:'456'}]}))}});
 assert.deepEqual(await reader.posts(['123']),[{id:'123',author_id:'456'}]);assert.equal(called,1);
 assert.throws(()=>new XClient({bearerToken:'test-token'}),/x_configuration_required/);
 await assert.rejects(()=>new XPostReader({}).posts(['123']),/x_read_access_not_configured/);
});
