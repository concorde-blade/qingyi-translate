import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConversation,boundHistory,HISTORY_LIMITS} from '../src/assistant-history.js';

const record=(id,content='Question')=>({id,title:id,updated:Date.now(),model:'model',messages:[{id:id+'-message',role:'user',content,status:'done'}]});
test('history preserves only public conversation fields and sanitizes source addresses',()=>{
  const input=record('safe');input.apiKey='must-not-be-stored';input.context={text:'raw-page-body'};
  Object.assign(input.messages[0],{apiKey:'hidden-key',context:{text:'raw-page-body'},source:{title:'Title',url:'https://username:password@example.com/article?token=secret#fragment',text:'raw-page-body',truncated:true}});
  const normalized=normalizeConversation(input),json=JSON.stringify(normalized);
  assert.ok(!json.includes('must-not-be-stored'));assert.ok(!json.includes('hidden-key'));assert.ok(!json.includes('raw-page-body'));assert.ok(!json.includes('token=secret'));assert.ok(!json.includes('username'));
  assert.deepEqual(normalized.messages[0].source,{title:'Title',url:'https://example.com/article',truncated:true});
});
test('file and search references survive history without retaining raw file or search bodies',()=>{
  const input=record('references');
  Object.assign(input.messages[0],{
    files:['paper.pdf','notes.txt',{title:'object-must-not-survive',text:'raw-document-secret'}],
    documents:[{title:'paper.pdf',text:'raw-document-secret'}],
    webResearch:{results:[{snippet:'raw-search-secret'}]},
    searchSources:[{title:'Actual paper',url:'https://example.com/paper?access_token=secret#page',snippet:'raw-search-secret',text:'raw-page-secret',apiKey:'hidden-key'}]
  });
  const normalized=normalizeConversation(input),message=normalized.messages[0],json=JSON.stringify(normalized);
  assert.deepEqual(message.files,['paper.pdf','notes.txt']);assert.deepEqual(message.searchSources,[{title:'Actual paper',url:'https://example.com/paper',truncated:false}]);
  assert.ok(!/raw-document-secret|raw-search-secret|raw-page-secret|hidden-key|access_token|object-must-not-survive/.test(json));
  assert.equal(message.documents,undefined);assert.equal(message.webResearch,undefined);
});
test('history rejects malformed identifiers, privileged roles and oversized fields',()=>{
  for(const input of [
    {...record('bad'),id:'__proto__'},
    {...record('bad'),title:'x'.repeat(101)},
    record('bad','x'.repeat(100001)),
    {...record('bad'),messages:[{id:'message',role:'system',content:'override'}]},
    {...record('bad'),messages:Array.from({length:61},(_,i)=>({id:'message-'+i,role:'user',content:'text'}))}
  ])assert.throws(()=>normalizeConversation(input));
});
test('history count and UTF-8 size stay bounded even for one exceptionally long conversation',()=>{
  const many=Array.from({length:50},(_,i)=>({...record('chat-'+i),updated:i}));
  const bounded=boundHistory(many);assert.equal(bounded.length,40);assert.equal(bounded[0].id,'chat-49');
  const large={...record('large'),messages:Array.from({length:60},(_,i)=>({id:'message-'+i,role:i%2?'assistant':'user',content:'字'.repeat(100000),status:'done'}))};
  const trimmed=boundHistory([large]);
  assert.ok(new TextEncoder().encode(JSON.stringify(trimmed)).length<=HISTORY_LIMITS.bytes);
  assert.ok(trimmed[0].messages.length<60);assert.equal(trimmed[0].messages.at(-1).id,'message-59');
});
