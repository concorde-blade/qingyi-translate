import test from 'node:test';
import assert from 'node:assert/strict';
import {decideWebSearch,buildSearchQuery} from '../src/assistant-intent.js';

const decide=(text,options={})=>decideWebSearch({text,enabled:true,...options});
test('explicit no-search and source-only instructions override enabled search',()=>{
  for(const text of ['不要联网，只根据这篇论文回答','不要搜索，分析我上传的附件','不要进行任何联网搜索','不需要联网','仅依据附件解释研究结论','只根据上传文件比较差异','只能使用所附资料','Do not search the web; explain the paper.',"Don't use web search.",'No web search. Compare the evidence.','Use only the attached documents.','Only use the provided files.']) {
    const result=decide(text,{hasDocuments:true});assert.equal(result.search,false,text);assert.equal(result.reason,'user-opt-out',text);
  }
  assert.equal(decide('不要仅依据附件，请联网搜索更多证据',{hasDocuments:true}).search,true);
});
test('short continuations never become independent searches',()=>{
  for(const text of ['继续','再详细一点','请展开说说','举个例子','然后呢？','为什么？','Continue','Tell me more','Explain more','What else?'])assert.equal(decide(text,{mode:'research'}).search,false,text);
});
test('greetings, writing, translation and coding remain ordinary model requests',()=>{
  for(const text of ['你好','谢谢！','写一份研究计划','请帮我写一封邮件','润色这篇论文的摘要','解释下面代码中的错误','实现二分搜索算法','write a research proposal','Explain this Python function','Debug this script','Translate this paper'])assert.equal(decide(text).search,false,text);
  assert.equal(decide('最新物理论文',{mode:'rewrite'}).search,false);
  assert.equal(decide('什么是量子纠缠',{mode:'translate'}).search,false);
});
test('factual and research questions can search when no source is already supplied',()=>{
  for(const text of ['什么是贝尔不等式？','量子纠缠实验的最新进展','比较两种量子通信方案','What is Bell’s theorem?','Current physics Nobel Prize','Explain quantum entanglement'])assert.equal(decide(text).search,true,text);
  assert.equal(decide('Altermagnetism',{mode:'research'}).search,true);
  for(const context of [{hasDocuments:true},{hasPage:true},{hasURLs:true}])assert.equal(decide('比较这些研究的证据',context).search,false);
});
test('explicit searches can accompany files or coding tasks but respect the globe switch',()=>{
  for(const text of ['请联网搜索这篇论文的后续研究','搜索贝尔不等式的最新实验','Please search for the latest paper','Look up references for this document','请联网查一下这段代码所用API的最新文档']) {
    const result=decide(text,{hasDocuments:true,mode:'rewrite'});assert.equal(result.search,true,text);assert.equal(result.explicit,true,text);
    assert.equal(decide(text,{enabled:false}).search,false);
  }
});
test('query construction uses only short user questions, never assistant or document bodies',()=>{
  const messages=[
    {role:'user',content:'什么是贝尔不等式？'},
    {role:'assistant',content:'ASSISTANT_BODY_DO_NOT_SEARCH'},
    {role:'user',content:'Pasted document body '.repeat(100)}
  ];
  const result=decide('请搜索它最新的实验结果',{messages,hasDocuments:true,documents:[{text:'RAW_FILE_DO_NOT_SEARCH'}],context:{text:'RAW_PAGE_DO_NOT_SEARCH'}});
  assert.equal(result.search,true);assert.match(result.query,/贝尔不等式/);
  assert.ok(!/ASSISTANT_BODY_DO_NOT_SEARCH|Pasted document|RAW_FILE_DO_NOT_SEARCH|RAW_PAGE_DO_NOT_SEARCH/.test(result.query));
  assert.equal(buildSearchQuery('Bell theorem',messages),'Bell theorem');
  assert.ok(buildSearchQuery('搜索 '+ 'x'.repeat(1000),messages).length<=300);
});
test('empty and unspecified requests default to no search',()=>{
  assert.equal(decideWebSearch().search,false);assert.equal(decide('   ').search,false);assert.equal(decide('我想聊聊我的计划').search,false);
});
