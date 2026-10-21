import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { SharedCache, boardId, plainText, validateDashboard } from '../lib/core.mjs';

const board = {data:{id:'hanul2026boardid',attributes:{title:'2026 한울'}},included:[{type:'section',id:'s1',attributes:{title:'교내 소식'}}]};
const post = {type:'post',id:'p1',attributes:{content:{subject:'<img src=x onerror=alert(1)>기사 제목',bodyHtml:'<p>한울 &amp; 독자</p><script>alert(1)</script><p>두 번째 문단</p>'}},relationships:{section:{data:{id:'s1'}}}};
const dashboard = {total:1,average:5,external:0,articles:[{label:'시트에만 있는 기사',count:1}],affiliations:[{label:'재학생',count:1}],updatedAt:new Date().toISOString()};
const json = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
async function fixture(t, overrides={}) {
  const dir = await mkdtemp(join(tmpdir(),'hanul-test-')); const calls = {sheetRead:0,sheetWrites:0,padlet:0};
  const fetchImpl = overrides.fetchImpl || (async(url,init={})=>{
    if(url.includes('api.padlet.dev')) {calls.padlet++;assert.equal(init.headers['X-API-KEY'],'test-key');return json(url.includes('/posts')?{data:[post]}:board);}
    if(init.method==='POST') {calls.sheetWrites++;const body=JSON.parse(init.body);assert.equal(body.sharedSecret,'test-secret');await new Promise(r=>setTimeout(r,25));return json({success:true,receipts:body.entries.map(x=>({requestId:x.requestId,ticketId:x.ticketId}))});}
    calls.sheetRead++;await new Promise(r=>setTimeout(r,25));return json({success:true,dashboard});
  });
  const server=await createApp({dataDir:dir,padletApiKey:'test-key',sheetsToken:'test-secret',fetchImpl,...overrides});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const request=(path,options={})=>fetch(base+path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
  async function login() {const result=await request('/api/admin/login',{method:'POST',body:JSON.stringify({password:'ADMIN'})});assert.equal(result.status,200);return result.headers.get('set-cookie').split(';')[0];}
  async function publish() {const cookie=await login();const response=await request('/api/admin/publish',{method:'PUT',headers:{Cookie:cookie},body:JSON.stringify({boardId:board.data.id,selectedIds:['p1']})});assert.equal(response.status,200);return cookie;}
  return {server,dir,calls,request,login,publish};
}

test('Padlet address and HTML normalization reject unsafe input',()=>{
  assert.equal(boardId('https://padlet.com/hanul/my-board-hanul2026boardid'),'hanul2026boardid');
  assert.throws(()=>boardId('https://evil.example/a-hanul2026boardid'));
  assert.equal(plainText('<script>bad()</script><p>기사 &amp; 독자</p>'),'기사 & 독자');
  assert.doesNotThrow(()=>plainText('&#999999999999;'));
});
test('60 simultaneous dashboard requests share one Sheets read and expose only aggregates',async t=>{
  const app=await fixture(t);
  const results=await Promise.all(Array.from({length:60},()=>app.request('/api/dashboard').then(async r=>({status:r.status,data:await r.json()}))));
  assert(results.every(r=>r.status===200&&r.data.dashboard.total===1));assert.equal(app.calls.sheetRead,1);
  assert.equal(results[0].data.dashboard.articles[0].label,'시트에만 있는 기사');
  assert(!JSON.stringify(results).includes('review'));assert(!JSON.stringify(results).includes('test-secret'));
});
test('no sample articles, real admin authentication, selection and durable publishing',async t=>{
  const app=await fixture(t);
  assert.deepEqual((await (await app.request('/api/articles')).json()).articles,[]);
  assert.equal((await app.request('/api/admin/settings')).status,401);
  assert.equal((await app.request('/api/admin/login',{method:'POST',body:'{"password":"wrong"}'})).status,401);
  const cookie=await app.publish();
  const articles=(await (await app.request('/api/articles')).json()).articles;
  assert.equal(articles.length,1);assert.equal(articles[0].title,'기사 제목');assert.equal(articles[0].content,'한울 & 독자\n두 번째 문단');
  const restart=await createApp({dataDir:app.dir});await new Promise(r=>restart.listen(0,'127.0.0.1',r));
  const response=await fetch(`http://127.0.0.1:${restart.address().port}/api/articles`);assert.equal((await response.json()).articles.length,1);await new Promise(r=>restart.close(r));
  const privateResponse=await app.request('/api/admin/settings',{headers:{Cookie:cookie}});assert.equal(privateResponse.status,200);assert(!JSON.stringify(await privateResponse.json()).includes('test-key'));
});
test('40 simultaneous submissions batch, confirm receipts and retry without duplicate writes',async t=>{
  const app=await fixture(t);await app.publish();
  const entries=Array.from({length:40},()=>({requestId:randomUUID(),affiliation:'재학생',gender:'남성',articleId:'p1',rating:5,review:'읽고 생각을 남깁니다.'}));
  const results=await Promise.all(entries.map(entry=>app.request('/api/feedback',{method:'POST',body:JSON.stringify(entry)}).then(async r=>({status:r.status,value:await r.json()}))));
  assert(results.every(x=>x.status===200&&x.value.ticketId));assert.equal(new Set(results.map(x=>x.value.ticketId)).size,40);assert(app.calls.sheetWrites<=2,`Expected <=2 batched writes, got ${app.calls.sheetWrites}`);
  const count=app.calls.sheetWrites;
  const retry=await app.request('/api/feedback',{method:'POST',body:JSON.stringify(entries[0])});assert.equal(retry.status,200);assert.equal(app.calls.sheetWrites,count);
  assert.equal((await app.request('/api/feedback',{method:'POST',body:JSON.stringify({...entries[0],review:'changed'})})).status,409);
});
test('invalid payloads, cross-site login, private files and proxy-key leakage are rejected',async t=>{
  const app=await fixture(t);await app.publish();
  const entry={requestId:randomUUID(),affiliation:'재학생',gender:'남성',articleId:'p1',rating:5,review:'평가'};
  for(const change of [{rating:0},{rating:NaN},{review:' '},{review:'x'.repeat(1001)},{articleId:'missing'},{requestId:'invalid'}])assert.equal((await app.request('/api/feedback',{method:'POST',body:JSON.stringify({...entry,...change})})).status,400);
  assert.equal(app.calls.sheetWrites,0);
  assert.equal((await app.request('/api/admin/login',{method:'POST',headers:{Origin:'https://evil.example'},body:'{"password":"ADMIN"}'})).status,403);
  for(const path of ['/.env','/data/settings.json','/server.mjs','/Code.gs','/package.json'])assert.equal((await app.request(path)).status,404);
});
test('upstream write failures never produce a successful ticket',async t=>{
  const app=await fixture(t,{fetchImpl:async(url,init={})=>url.includes('api.padlet.dev')?json(url.includes('/posts')?{data:[post]}:board):json({success:false,error:'write failed'})});await app.publish();
  const result=await app.request('/api/feedback',{method:'POST',body:JSON.stringify({requestId:randomUUID(),affiliation:'재학생',gender:'여성',articleId:'p1',rating:4,review:'평가'})});assert.equal(result.status,502);assert(!('ticketId' in await result.json()));
});
test('a failed cold cache is shared; stale responses are explicitly marked',async()=>{
  let calls=0;const cache=new SharedCache(1,10000);const loader=async()=>{calls++;throw Error('offline');};
  await assert.rejects(cache.get(loader));await assert.rejects(cache.get(loader));assert.equal(calls,1);
  const stale=new SharedCache(0,10000);await stale.get(async()=>({total:7}));const result=await stale.get(loader);assert.equal(result.stale,true);assert.equal(result.value.total,7);
  assert.throws(()=>validateDashboard({success:true,dashboard:{...dashboard,total:5}}));
});
test('Padlet pagination imports every page and never sends the API key to another host',async t=>{
  let calls=0;const app=await fixture(t,{fetchImpl:async(url)=>{calls++;if(url.includes('include=sections'))return json(board);if(url.includes('page=2'))return json({data:[{...post,id:'p2'}]});return json({data:[post],links:{next:'?page=2'}});}});
  const cookie=await app.login();const response=await app.request('/api/admin/padlet',{method:'POST',headers:{Cookie:cookie},body:JSON.stringify({board:board.data.id})});assert.equal(response.status,200);assert.equal((await response.json()).articles.length,2);assert.equal(calls,3);
  const hostile=await fixture(t,{fetchImpl:async(url)=>url.includes('include=sections')?json(board):json({data:[post],links:{next:'https://evil.example/v1/posts'}})});
  const hostileCookie=await hostile.login();const failed=await hostile.request('/api/admin/padlet',{method:'POST',headers:{Cookie:hostileCookie},body:JSON.stringify({board:board.data.id})});assert.equal(failed.status,502);
});
