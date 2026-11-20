import test from 'node:test';
import assert from 'node:assert/strict';
import {publicSourceURL,sourceURLs,readRemoteDocument} from '../src/source-reader.js';

test('source URLs accept ordinary links and reject private networks, credentials and secret parameters',()=>{
  assert.equal(publicSourceURL('https://example.com/paper?version=2#page'),'https://example.com/paper?version=2');
  for(const value of [
    'file:///private/file','javascript:alert(1)','https://username:password@example.com/file',
    'https://localhost/file','https://127.0.0.1/file','https://0x7f000001/file','https://10.1.2.3/file',
    'https://172.16.1.1/file','https://192.168.1.1/file','https://169.254.169.254/metadata',
    'https://100.64.0.1/file','https://198.18.0.1/file','https://[::1]/file','https://files.internal/file',
    'https://example.com:8443/file','https://example.com/file?token=secret','https://example.com/file?X-Amz-Signature=secret'
  ])assert.throws(()=>publicSourceURL(value),{name:'Error'},value);
  assert.deepEqual(sourceURLs('Compare https://example.com/a, https://example.com/a and https://example.com/b.'),['https://example.com/a','https://example.com/b']);
  const links = Array.from({length:5},(_,index) => `https://example.com/paper-${index}`);
  assert.deepEqual(sourceURLs(links.join(' ')), links, 'all links reach the caller so its four-document limit can reject rather than silently omit material');
});

test('remote text downloads omit cookies and block redirects while truncating excessive text visibly',async()=>{
  const result=await readRemoteDocument('https://example.com/paper.txt',{fetchImpl:async(url,options)=>{
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.signal.aborted,false);
    return new Response('x'.repeat(49000),{headers:{'Content-Type':'text/plain;charset=utf-8'}});
  }});
  assert.equal(result.text.length,48000);assert.equal(result.truncated,true);assert.equal(result.kind,'text');assert.equal(result.url,'https://example.com/paper.txt');
});

test('oversized declared downloads are cancelled before reading their bodies',async()=>{
  let cancelled=false;
  await assert.rejects(()=>readRemoteDocument('https://example.com/large.txt',{fetchImpl:async()=>new Response(new ReadableStream({start(){},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/plain','Content-Length':String(21*1024*1024)}})}),/20 MB/);
  assert.equal(cancelled,true);
});

test('streamed downloads are bounded even when content length is missing',async()=>{
  let cancelled=false;
  await assert.rejects(()=>readRemoteDocument('https://example.com/large.txt',{fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(11*1024*1024));controller.enqueue(new Uint8Array(11*1024*1024));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/plain'}})}),/20 MB/);
  assert.equal(cancelled,true);
});

test('already cancelled source reads do not fetch',async()=>{
  const controller=new AbortController();controller.abort();
  let calls=0;
  await assert.rejects(()=>readRemoteDocument('https://example.com/file.txt',{signal:controller.signal,fetchImpl:async()=>{calls++;return new Response('Text',{headers:{'Content-Type':'text/plain'}});}}),/停止/);
  assert.equal(calls,0);
});

test('source cancellation interrupts a stalled body read instead of leaving the UI waiting',async()=>{
  const controller=new AbortController();let stream,started;
  const begin=new Promise(resolve=>{started=resolve;});
  const task=readRemoteDocument('https://example.com/file.txt',{signal:controller.signal,fetchImpl:async()=>{started();return new Response(new ReadableStream({start(value){stream=value;}}),{headers:{'Content-Type':'text/plain'}});}});
  const outcome=task.then(()=>({resolved:true}),error=>({error}));
  await begin;controller.abort();
  const result=await Promise.race([outcome,new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),150))]);
  try{stream.close();}catch{}
  await outcome;
  assert.equal(result.timeout,undefined);assert.match(result.error?.message||'',/停止/);
});
