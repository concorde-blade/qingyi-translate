import test from 'node:test';
import assert from 'node:assert/strict';
import {webSearch,SEARCH_ORIGINS,SEARCH_MAX_BYTES,SEARCH_TIMEOUT_MS} from '../src/web-search.js';

const packet=results=>({jsonrpc:'2.0',id:1,result:{structuredContent:{results}}});
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const sample={title:'Bell theorem',url:'https://www.nobelprize.org/prizes/physics/2022/press-release/',snippet:'Experiments violating Bell inequalities.'};
const textPacket=text=>({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text}]}});
const entry=(title,url,body)=>`Title: ${title}\nURL: ${url}\nPublished: N/A\nAuthor: N/A\nHighlights:\n${body}`;

test('search requires a bounded query and only needs the hosted public search origin',async()=>{
  assert.deepEqual(SEARCH_ORIGINS,['https://mcp.exa.ai/*']);
  for(const query of ['', '   ',null,{},'x'.repeat(301)])await assert.rejects(()=>webSearch(query,{fetchImpl:()=>assert.fail('invalid input must not send a request')}),{code:'SEARCH_QUERY'});
});

test('search calls the real MCP protocol without cookies, credentials or redirects',async()=>{
  const result=await webSearch('  Bell theorem\nphysics  ',{fetchImpl:async(url,options)=>{
    assert.equal(url,'https://mcp.exa.ai/mcp');assert.equal(options.method,'POST');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['x-api-key'],undefined);
    const body=JSON.parse(options.body);assert.equal(body.method,'tools/call');assert.equal(body.params.name,'web_search_exa');
    assert.deepEqual(body.params.arguments,{query:'Bell theorem physics',numResults:6});return json(packet([sample]));
  }});
  assert.equal(result.query,'Bell theorem physics');assert.equal(result.provider,'Exa');assert.deepEqual(result.results,[sample]);
});

test('split UTF-8 MCP event streams finish on the response without waiting for connection close',async()=>{
  let cancelled=false;
  const body=entry('量子纠缠','https://physics.example.com/article','实验验证了贝尔不等式的违反。');
  const events=': keepalive\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: '+JSON.stringify(textPacket(body))+'\r\n\r\n';
  const bytes=new TextEncoder().encode(events);
  const result=await webSearch('量子纠缠',{fetchImpl:async()=>new Response(new ReadableStream({
    start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));},
    cancel(){cancelled=true;}
  }),{headers:{'Content-Type':'text/event-stream'}})});
  assert.equal(result.results[0].title,'量子纠缠');assert.equal(result.results[0].snippet,'实验验证了贝尔不等式的违反。');assert.equal(cancelled,true);
});

test('search cleans HTML entities and tags, deduplicates canonical links and caps results',async()=>{
  const entries=[
    entry('&lt;b&gt;Bell &amp; CHSH&lt;/b&gt;','https://physics.example.com/bell?utm_source=test#part','<script>unsafe()</script><p>Entangled &#112;hotons &mdash; measured.</p>'),
    entry('Duplicate','https://physics.example.com/bell/#other','Repeated'),
    ...Array.from({length:8},(_,index)=>entry('Result '+index,'https://science.example.com/paper/'+index,'x'.repeat(1800)))
  ];
  const result=await webSearch('Bell',{fetchImpl:async()=>json(textPacket(entries.join('\n\n---\n\n')))});
  assert.equal(result.results.length,6);assert.equal(result.results[0].title,'Bell & CHSH');assert.equal(result.results[0].snippet,'Entangled photons — measured.');
  assert.equal(result.results[0].url,'https://physics.example.com/bell');assert.equal(result.results[1].snippet.length,1400);
});

test('search rejects non-HTTPS, local, credential-bearing and search-engine redirect links',async()=>{
  const badURLs=[
    'http://example.com/paper','javascript:alert(1)','file:///private/file','https://user:secret@example.com/paper',
    'https://127.0.0.1/path','https://localhost/path','https://server.local/path','https://192.168.1.2/path','https://[::1]/',
    'https://example.com:8443/path','https://www.google.com/url?q=https://example.com','https://www.google.com/search?q=Bell',
    'https://www.bing.com/ck/a?u=encoded','https://cn.bing.com/search?q=Bell','https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com',
    'https://www.google.com/?q=Bell','https://duckduckgo.com/?q=Bell',
    'https://www.baidu.com/link?url=encoded','https://r.search.yahoo.com/redirect','https://mcp.exa.ai/mcp'
  ];
  const result=await webSearch('Bell',{fetchImpl:async()=>json(packet([...badURLs.map(url=>({title:'Bad',url,snippet:'Untrusted'})),sample]))});
  assert.deepEqual(result.results,[sample]);
});

test('service and protocol errors remain explicit without leaking raw error bodies',async()=>{
  for(const [status,code] of [[429,'SEARCH_RATE_LIMIT'],[403,'SEARCH_ACCESS'],[500,'SEARCH_HTTP']]) {
    let calls=0;await assert.rejects(()=>webSearch('Bell',{fetchImpl:async()=>{calls++;return new Response('private-service-error',{status});}}),{code});assert.equal(calls,1);
  }
  for(const [value,code] of [
    [{jsonrpc:'2.0',id:1,error:{message:'Rate limit 429 private-service-error'}},'SEARCH_RATE_LIMIT'],
    [{jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:'private-service-error'}]}},'SEARCH_SERVICE'],
    [packet([]),'SEARCH_EMPTY'],[{jsonrpc:'2.0',id:999,result:{}},'SEARCH_RESPONSE']
  ])await assert.rejects(()=>webSearch('Bell',{fetchImpl:async()=>json(value)}),error=>error.code===code && !error.message.includes('private-service-error'));
  await assert.rejects(()=>webSearch('Bell',{fetchImpl:async()=>new Response('not-json')}),{code:'SEARCH_RESPONSE'});
});

test('response limits cover declared length and streamed bytes',async()=>{
  await assert.rejects(()=>webSearch('Bell',{fetchImpl:async()=>new Response('small',{headers:{'Content-Length':String(SEARCH_MAX_BYTES+1)}})}),{code:'SEARCH_SIZE'});
  let cancelled=false;
  await assert.rejects(()=>webSearch('Bell',{fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(SEARCH_MAX_BYTES+1));},cancel(){cancelled=true;}}))}),{code:'SEARCH_SIZE'});
  assert.equal(cancelled,true);
});

test('cancellation stops both an unresponsive fetch and an open response body',async()=>{
  const already=new AbortController();already.abort();
  await assert.rejects(()=>webSearch('Bell',{signal:already.signal,fetchImpl:()=>assert.fail('already cancelled')}),{code:'CANCELLED'});
  for(const phase of ['fetch','body']) {
    const controller=new AbortController();let begin;
    const started=new Promise(resolve=>{begin=resolve;});
    const pending=webSearch('Bell',{signal:controller.signal,fetchImpl:async()=>{
      begin();return phase==='fetch'?new Promise(()=>{}):new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'text/event-stream'}});
    }});
    await started;controller.abort();await assert.rejects(pending,{code:'CANCELLED'});
  }
});

test('timeout bounds a provider that never responds',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=webSearch('Bell',{fetchImpl:async()=>new Promise(()=>{})});
  t.mock.timers.tick(SEARCH_TIMEOUT_MS);
  await assert.rejects(pending,{code:'SEARCH_TIMEOUT'});
  t.mock.timers.reset();
});
