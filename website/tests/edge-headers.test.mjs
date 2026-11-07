import test from 'node:test';import assert from 'node:assert/strict';
import {originRequestHeaders} from '../edge.mjs';
import {createApi} from '../src/api.mjs';
test('proxy forwards only needed auth and request headers, not oversized unrelated browser state',()=>{
 const request=new Request('https://pillv1.fun/api/media',{headers:{'content-type':'application/json',origin:'https://pillv1.fun',authorization:'Bearer test',cookie:'privy-token='+ 'x'.repeat(7000)+'; launchpad_session=session_123; analytics=discard','x-trace-padding':'x'.repeat(18000),'x-real-ip':'spoofed','x-pill-client-ip':'spoofed','x-pill-origin':'spoofed','cf-connecting-ip':'203.0.113.2'}});
 const h=originRequestHeaders(request,'actual-origin-token');assert.equal(h.get('cookie'),'launchpad_session=session_123');assert.equal(h.get('authorization'),'Bearer test');assert.equal(h.get('origin'),'https://pillv1.fun');assert.equal(h.get('content-type'),'application/json');assert.equal(h.get('x-pill-client-ip'),'203.0.113.2');assert.equal(h.get('x-pill-origin'),'actual-origin-token');assert(!h.has('x-real-ip'));assert(!h.has('x-trace-padding'));assert(JSON.stringify([...h]).length<1000);
});
test('non-JSON upload errors preserve the HTTP cause instead of claiming service is unconnected',async()=>{
 for(const [status,pattern] of [[431,/headers/],[413,/too large/],[503,/temporarily unavailable/]]){
  const api=createApi({fetcher:async()=>new Response('',{status})});await assert.rejects(api.request('/media',{method:'POST',body:{}}),e=>e.status===status&&pattern.test(e.message));
 }
});
