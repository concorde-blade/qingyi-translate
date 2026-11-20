import {LOCAL_SETTINGS} from './local-settings.js';
import {DEFAULTS, validateSettings, performanceSettings, migratePerformance, endpointURL, splitText, requestTranslation, RequestQueue, TranslateError, httpError, RateGate} from './core.js';
import {assistantRequestId, validateAssistantRequest, requestAssistant} from './assistant-core.js';
import {conversationId, normalizeConversation, boundHistory} from './assistant-history.js';
import {extractPageContext} from './page-context.js';
import {webSearch, SEARCH_ORIGINS} from './web-search.js';
import {buildSearchQuery} from './assistant-intent.js';

// Credentials are accessible only to extension pages and this worker, never content scripts.
const accessReady = (async()=>{
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  if(LOCAL_SETTINGS && !(await chrome.storage.local.get('settings')).settings) {
    // A damaged optional seed must not prevent opening settings and repairing it.
    let seed;
    try {seed=validateSettings(migratePerformance(LOCAL_SETTINGS));} catch {}
    if(seed)await chrome.storage.local.set({settings:seed});
  }
  const saved=(await chrome.storage.local.get('settings')).settings;
  if(saved && saved.performanceVersion!==1)await chrome.storage.local.set({settings:migratePerformance(saved)});
})();
const queue = new RequestQueue(DEFAULTS.concurrency);
const gateReady=(async()=>{
  const {rateState:saved}=await chrome.storage.session.get('rateState');
  // Discard the previous release's sticky slowdown, but retain an active Retry-After.
  const state=saved?.policyVersion===1 || saved?.cooldownUntil>Date.now()?saved:{};
  return new RateGate({...state,policyVersion:1},{persist:rateState=>chrome.storage.session.set({rateState})});
})();
const requests = new Map();
const assistantRequests = new Map();
const cancelledAssistantRequests = new Map();
let assistantHistoryQueue=Promise.resolve();
const cancelledRuns = new Map();
const cache = new Map();
let keepAliveTimer;
function updateKeepAlive() {
  const active=requests.size+assistantRequests.size;
  if(active && !keepAliveTimer)keepAliveTimer=setInterval(()=>chrome.runtime.getPlatformInfo().catch(()=>{}),20000);
  if(!active && keepAliveTimer){clearInterval(keepAliveTimer);keepAliveTimer=null;}
}
let configVersion = 0;
async function settings() { await accessReady; return validateSettings((await chrome.storage.local.get('settings')).settings || DEFAULTS); }
function safeError(error) { return {ok: false, error: error instanceof TranslateError ? error.message : '扩展连接中断，请刷新网页后重试。', code: error?.code || 'INTERNAL', retryAt: Number(error?.retryAt) || 0}; }
function owner(sender) { return sender.tab ? `tab:${sender.tab.id}` : 'settings'; }
function cancelOwner(prefix, runId) {
  if(runId) {
    cancelledRuns.set(`${prefix}:${runId}`,Date.now());
    if(cancelledRuns.size>1000)cancelledRuns.delete(cancelledRuns.keys().next().value);
  }
  for (const [id, r] of requests) if (r.owner === prefix && (!runId || r.runId === runId)) { r.controller.abort(); requests.delete(id); }
}
async function translate(message, sender) {
  await accessReady;
  const version = configVersion;
  const s = await settings();
  queue.setLimit(s.concurrency);
  const url = endpointURL(s.endpoint);
  if (!await chrome.permissions.contains({origins: [`${url.origin}/*`]})) throw new TranslateError('尚未授权访问翻译接口，请打开设置后点击“保存并授权”。', 'PERMISSION');
  if(version!==configVersion)throw new TranslateError('设置已更改，请重试翻译。','CANCELLED');
  const text = String(message.text || '').trim();
  if (!text || text.length > 16000) throw new TranslateError('请选择 1 到 16000 字符的文本。', 'TEXT_SIZE');
  const context = {title: String(message.context?.title || '').slice(0, 240), before: String(message.context?.before || '').slice(-1200), after: String(message.context?.after || '').slice(0, 1200)};
  // Do not store keys in cache indexes; clear the session cache whenever settings change.
  const key = JSON.stringify([version, s.endpoint, s.model, s.target, s.domain, s.glossary, text, context]);
  const id = crypto.randomUUID();
  const record = {owner: owner(sender), runId: String(message.runId || ''), controller: new AbortController()};
  // A close / restore can arrive while settings and permissions are still loading.
  if(cancelledRuns.has(`${record.owner}:${record.runId}`))throw new TranslateError('已停止翻译。','CANCELLED');
  if (cache.has(key)) return {ok: true, text: cache.get(key), cached: true};
  if (requests.size+assistantRequests.size >= 48) throw new TranslateError('等待处理的任务较多，请稍后再试。', 'BUSY');
  requests.set(id, record);
  updateKeepAlive();
  let progressTimer,lastProgressAt=0,pendingProgress;
  const deliver=()=>{
    progressTimer=null;
    if(record.controller.signal.aborted || version!==configVersion || !sender.tab)return;
    lastProgressAt=Date.now();
    const options=sender.documentId?{documentId:sender.documentId}:{frameId:0};
    chrome.tabs.sendMessage(sender.tab.id,{type:'TRANSLATE_PROGRESS',runId:record.runId,...pendingProgress},options).catch(()=>{});
  };
  const progress=(text,phase='streaming')=>{
    pendingProgress={text,phase};
    if(Date.now()-lastProgressAt>=70){clearTimeout(progressTimer);deliver();}
    else if(!progressTimer)progressTimer=setTimeout(deliver,70);
  };
  progress('','waiting');
  try {
      const chunks = splitText(text),translated = [];
      for (let i = 0; i < chunks.length; i++) {
        if(record.controller.signal.aborted)throw new TranslateError('已停止翻译。','CANCELLED');
        const chunkContext={...context, before: i ? chunks[i-1].slice(-1200) : context.before, after: i+1 < chunks.length ? chunks[i+1].slice(0,1200) : context.after};
        const chunkKey=JSON.stringify(['chunk',version,s.endpoint,s.model,s.target,s.domain,s.glossary,chunks[i],chunkContext]);
        if(cache.has(chunkKey)){translated.push(cache.get(chunkKey));continue;}
        const gate=await gateReady;
        const value=await queue.run(async()=>{try {
          const prefix=translated.length?translated.join('\n')+'\n':'';
          const value=await requestTranslation(chunks[i],chunkContext,s,{
            signal:record.controller.signal,
            beforeAttempt:async signal=>{await gate.before(signal,s.requestInterval);progress(prefix,'generating');},
            onProgress:text=>progress(prefix+text)
          });
          await gate.success();return value;
        } catch(error) {
          if(error.code==='HTTP_429') throw await gate.limited(error,s.requestInterval);
          throw error;
        }},record.controller.signal,message.priority===true);
        translated.push(value);
        if(version===configVersion){cache.set(chunkKey,value);if(cache.size>300)cache.delete(cache.keys().next().value);}
      }
    const result=translated.join('\n');
    if (record.controller.signal.aborted) throw new TranslateError('已停止翻译。', 'CANCELLED');
    if (version === configVersion) { cache.set(key, result); if (cache.size > 300) cache.delete(cache.keys().next().value); }
    return {ok: true, text: result, cached: false};
  } finally {clearTimeout(progressTimer);requests.delete(id);updateKeepAlive();}
}
function assistantKey(sender,requestId) {
  return `${sender.documentId || sender.url}:${requestId}`;
}
function cancelAssistant(sender,requestId) {
  const key=assistantKey(sender,assistantRequestId(requestId));
  cancelledAssistantRequests.set(key,Date.now());
  if(cancelledAssistantRequests.size>1000)cancelledAssistantRequests.delete(cancelledAssistantRequests.keys().next().value);
  assistantRequests.get(key)?.controller.abort();
  return {ok:true};
}
async function assistantChat(message,sender) {
  const request=validateAssistantRequest(message),key=assistantKey(sender,request.requestId);
  if(cancelledAssistantRequests.has(key))throw new TranslateError('已停止生成。','CANCELLED');
  if(assistantRequests.has(key))throw new TranslateError('这条请求正在处理中，请勿重复发送。','BUSY');
  if(requests.size+assistantRequests.size>=48)throw new TranslateError('等待处理的任务较多，请稍后再试。','BUSY');
  const version=configVersion,record={controller:new AbortController()};
  // Register before the first await so a fast Stop also cancels setup and queueing.
  assistantRequests.set(key,record);updateKeepAlive();
  let progressTimer,lastProgressAt=0,pendingProgress;
  const deliver=()=>{
    progressTimer=null;
    if(record.controller.signal.aborted || version!==configVersion)return;
    lastProgressAt=Date.now();
    chrome.runtime.sendMessage({type:'ASSISTANT_PROGRESS',requestId:request.requestId,...pendingProgress}).catch(()=>{});
  };
  const progress=(text,phase='streaming')=>{
    pendingProgress={text,phase};
    if(Date.now()-lastProgressAt>=70){clearTimeout(progressTimer);deliver();}
    else if(!progressTimer)progressTimer=setTimeout(deliver,70);
  };
  const checkCancelled=()=>{
    if(record.controller.signal.aborted || version!==configVersion)throw new TranslateError(version!==configVersion?'设置已更改，请重新发送。':'已停止生成。','CANCELLED');
  };
  try {
    progress('','waiting');
    const s=await settings();checkCancelled();queue.setLimit(s.concurrency);
    const url=endpointURL(s.endpoint);
    if(!await chrome.permissions.contains({origins:[`${url.origin}/*`]}))throw new TranslateError('尚未授权访问 AI 服务，请打开设置后点击“保存并授权”。','PERMISSION');
    checkCancelled();
    if(request.webSearch) {
      if(!await chrome.permissions.contains({origins:SEARCH_ORIGINS}))throw new TranslateError('请先开启联网按钮并允许搜索访问。','PERMISSION');
      progress('','searching');
      const query=buildSearchQuery(request.messages.at(-1).content,request.messages.slice(0,-1));
      const found=await webSearch(query,{signal:record.controller.signal});checkCancelled();
      request.webResearch={...found,searchedAt:new Date().toISOString().slice(0,10)};
    }
    const gate=await gateReady;
    const text=await queue.run(async()=>{
      try {
        const result=await requestAssistant(request,s,{
          signal:record.controller.signal,
          beforeAttempt:async signal=>{await gate.before(signal,s.requestInterval);progress('','generating');},
          onProgress:text=>progress(text)
        });
        await gate.success();return result;
      } catch(error) {
        if(error.code==='HTTP_429')throw await gate.limited(error,s.requestInterval);
        throw error;
      }
    },record.controller.signal,true);
    checkCancelled();return {ok:true,text,sources:request.webResearch?.results.map(({title,url})=>({title,url})) || []};
  } finally {clearTimeout(progressTimer);assistantRequests.delete(key);updateKeepAlive();}
}
async function assistantConfig() {
  await accessReady;
  const saved=(await chrome.storage.local.get('settings')).settings;
  const s={...DEFAULTS,...saved};
  let configured=false,endpoint='';
  try {
    endpoint=endpointURL(s.endpoint).href;
    validateSettings(s);
    configured=await chrome.permissions.contains({origins:[`${new URL(endpoint).origin}/*`]});
  } catch {}
  return {ok:true,model:String(s.model||'').slice(0,160),target:s.target,endpoint,configured};
}
function updateAssistantHistory(operation,payload) {
  const record=operation==='save'?normalizeConversation(payload):null;
  const id=record?.id || conversationId(payload);
  const task=assistantHistoryQueue.catch(()=>{}).then(async()=>{
    await accessReady;
    const [{assistantHistory:stored},{assistantHistoryDeleted:deleted={}}]=await Promise.all([
      chrome.storage.local.get('assistantHistory'),chrome.storage.session.get('assistantHistoryDeleted')
    ]);
    const tombstones=deleted && typeof deleted==='object' && !Array.isArray(deleted)?{...deleted}:{};
    let history=boundHistory(stored);
    if(operation==='save') {
      // Old sidebars may still deliver a queued save after another window deletes it.
      if(Object.hasOwn(tombstones,id))return {ok:false,code:'CONVERSATION_DELETED',error:'这条对话已在另一个窗口删除，请新建对话后继续。',history};
      record.updated=Date.now();
      history=boundHistory([record,...history.filter(item=>item.id!==id)]);
    } else {
      history=history.filter(item=>item.id!==id);tombstones[id]=Date.now();
      const retained=Object.fromEntries(Object.entries(tombstones).sort((a,b)=>b[1]-a[1]).slice(0,1000));
      await chrome.storage.session.set({assistantHistoryDeleted:retained});
    }
    await chrome.storage.local.set({assistantHistory:history});
    return {ok:true,history};
  });
  assistantHistoryQueue=task.then(()=>{},()=>{});
  return task;
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({target: {tabId}, files: ['content.js']}); }
  catch { throw new TranslateError('此页面无法使用扩展。请在普通网页中操作；浏览器设置、应用商店和内置 PDF 页面不支持。', 'PAGE_RESTRICTED'); }
}
async function pageAction(tabId, action, text) {
  if (!Number.isInteger(tabId)) throw new TranslateError('没有找到当前网页。', 'PAGE_RESTRICTED');
  await inject(tabId);
  try {
    const response=await chrome.tabs.sendMessage(tabId, {type: 'PAGE_ACTION', action, text});
    if(!response)throw new Error('No page response');
    return response;
  } catch {throw new TranslateError('插件已更新或连接中断，请刷新当前网页后重试。','DISCONNECTED');}
}
async function pageContext(requestedTabId) {
  const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
  if (!tab?.id || (requestedTabId != null && requestedTabId !== tab.id)) throw new TranslateError('当前网页已切换，请重新附加页面。','PAGE_CHANGED');
  if (tab.url && !/^https?:/.test(tab.url)) throw new TranslateError('此页面无法读取。请打开普通网页；浏览器设置和内置 PDF 暂不支持。','PAGE_RESTRICTED');
  let execution;
  try {[execution] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractPageContext});}
  catch {throw new TranslateError('请在当前网页点击工具栏的墨序图标，再打开 AI 助手侧栏并附加页面。','PAGE_ACCESS');}
  if (!execution?.result?.text) throw new TranslateError('没有找到可读取的正文。可复制需要的内容到输入框中提问。','EMPTY_PAGE');
  const [current] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
  if (current?.id !== tab.id || current.url !== tab.url) throw new TranslateError('页面已变化，请重新附加后再试。','PAGE_CHANGED');
  return {ok:true,tabId:tab.id,context:execution.result};
}
const internalPage = sender => typeof sender.url==='string' && sender.url.startsWith(chrome.runtime.getURL(''));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    const internal = internalPage(sender);
    if (message.type === 'OPEN_ASSISTANT') {
      if (!sender.tab?.id || sender.frameId !== 0 || !/^https?:/.test(sender.url || '')) throw new TranslateError('请从工具栏的墨序图标打开侧栏。','PAGE_RESTRICTED');
      try {await chrome.sidePanel.open({tabId:sender.tab.id});return {ok:true};}
      catch {throw new TranslateError('请点击工具栏的墨序图标，选择“打开 AI 助手侧栏”。','SIDEPANEL');}
    }
    if(message.type==='GET_PREFERENCES') {
      await accessReady;
      const {settings:s}=await chrome.storage.local.get('settings');
      return {ok:true,selectionToolbar:s?.selectionToolbar!==false,concurrency:performanceSettings(s).concurrency};
    }
    if(message.type==='OPEN_OPTIONS') {await chrome.runtime.openOptionsPage();return {ok:true};}
    if (message.type === 'TRANSLATE') {
      if (!internal && (!sender.tab || !/^https?:/.test(sender.url || '') || sender.frameId !== 0)) throw new TranslateError('当前页面不受支持。', 'PAGE_RESTRICTED');
      return translate(message, sender);
    }
    if (message.type === 'CANCEL') { cancelOwner(owner(sender), message.runId); return {ok: true}; }
    if (!internal) throw new TranslateError('操作不可用。', 'FORBIDDEN');
    if (message.type === 'GET_ASSISTANT_CONFIG') return assistantConfig();
    if (message.type === 'ASSISTANT_CHAT') return assistantChat(message,sender);
    if (message.type === 'ASSISTANT_CANCEL') return cancelAssistant(sender,message.requestId);
    if (message.type === 'ASSISTANT_SAVE_CONVERSATION') return updateAssistantHistory('save',message.conversation);
    if (message.type === 'ASSISTANT_DELETE_CONVERSATION') return updateAssistantHistory('delete',message.conversationId);
    if (message.type === 'GET_PAGE_CONTEXT') return pageContext(message.tabId);
    if(message.type==='PREPARE_FLOAT') {
      const origin=new URL(message.origin).origin;
      const tab=await chrome.tabs.get(message.tabId);
      if(!/^https?:/.test(origin) || new URL(tab.url).origin!==origin)throw new TranslateError('请选择当前网页。','PAGE_RESTRICTED');
      await chrome.storage.session.set({pendingFloat:{origin,tabId:message.tabId,at:Date.now()}});
      return {ok:true};
    }
    if(message.type==='FLOAT_SITE') {
      const origin=new URL(message.origin).origin+'/*';
      const tab=await chrome.tabs.get(message.tabId);
      if(!/^https?:/.test(origin) || new URL(tab.url).origin+'/*'!==origin)throw new TranslateError('请选择当前网页。','PAGE_RESTRICTED');
      if(!/^https?:/.test(origin) || !await chrome.permissions.contains({origins:[origin]})) throw new TranslateError('请先授权当前网站。','PERMISSION');
      const {floatingOrigins=[]}=await chrome.storage.local.get('floatingOrigins');
      await chrome.storage.local.set({floatingOrigins:[...new Set([...floatingOrigins,origin])]});
      await syncFloating(); await chrome.storage.session.remove('pendingFloat');await inject(message.tabId); return {ok:true};
    }
    if(message.type==='UNFLOAT_SITE') {
      const origin=new URL(message.origin).origin+'/*';
      const {floatingOrigins=[]}=await chrome.storage.local.get('floatingOrigins');
      await chrome.storage.local.set({floatingOrigins:floatingOrigins.filter(item=>item!==origin)});
      await chrome.storage.session.remove('pendingFloat');await syncFloating();
      // Stop already-injected pages of this site as well as future navigation.
      for(const tab of await chrome.tabs.query({})) {
        if(!tab.url?.startsWith(origin.slice(0,-1)))continue;
        await chrome.tabs.sendMessage(tab.id,{type:'PAGE_ACTION',action:'hide-launcher'}).catch(()=>{});
      }
      return {ok:true};
    }
    if(message.type==='SITE_STATUS') {
      const origin=new URL(message.origin).origin+'/*';
      const {floatingOrigins=[]}=await chrome.storage.local.get('floatingOrigins');
      return {ok:true,enabled:floatingOrigins.includes(origin) && await chrome.permissions.contains({origins:[origin]})};
    }
    if (message.type === 'PAGE') return {ok: true, ...(await pageAction(message.tabId, message.action))};
    if (message.type === 'MODELS') {
      const s=await settings(), url=endpointURL(s.endpoint);
      if (!await chrome.permissions.contains({origins:[`${url.origin}/*`]})) throw new TranslateError('请先保存并授权接口地址。','PERMISSION');
      url.pathname=url.pathname.replace(/\/chat\/completions$/, '/models');
      let response;
      try { response=await fetch(url.href,{headers:s.apiKey?{Authorization:`Bearer ${s.apiKey}`}:{},signal:AbortSignal.timeout(15000),credentials:'omit',redirect:'error',cache:'no-store'}); }
      catch {throw new TranslateError(url.hostname==='api.llm.ustc.edu.cn'?'无法连接 USTC，请检查校园网或 iWAN 隧道。':'无法读取模型，请检查网络和接口地址。','NETWORK');}
      if(!response.ok)throw httpError(response.status);
      let data;try{data=await response.json();}catch{throw new TranslateError('模型列表不是有效 JSON，可手动填写模型名称。','INVALID_RESPONSE');}
      const models=Array.isArray(data.data)?data.data.map(m=>m.id).filter(id=>typeof id==='string'&&id.length<=160&&!/embedding|reranker|ocr/i.test(id)):[];
      if(!models.length)throw new TranslateError('服务没有返回可用文本模型；可按平台文档手动填写。','EMPTY_RESPONSE');
      return {ok:true,models:[...new Set(models)].sort()};
    }
    if (message.type === 'CLEAR_CACHE') { cache.clear(); return {ok: true}; }
    if (message.type === 'SAVE') { const s = validateSettings(message.settings); await accessReady; await chrome.storage.local.set({settings: s}); return {ok: true}; }
    if (message.type === 'GET_SETTINGS') {await accessReady;const saved=(await chrome.storage.local.get('settings')).settings;return {ok:true,settings:{...DEFAULTS,...saved,...performanceSettings(saved)}};}
    throw new TranslateError('不支持的操作。', 'UNKNOWN_ACTION');
  })().then(respond).catch(error => respond(safeError(error)));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    configVersion++;cache.clear();for(const r of requests.values())r.controller.abort();
    for(const r of assistantRequests.values())r.controller.abort();
    queue.setLimit(performanceSettings(changes.settings.newValue).concurrency);
    chrome.tabs.query({}).then(tabs=>Promise.all(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'PAGE_ACTION',action:'settings-changed',selectionToolbar:changes.settings.newValue?.selectionToolbar!==false,concurrency:performanceSettings(changes.settings.newValue).concurrency}).catch(()=>{})))).catch(()=>{});
  }
});
chrome.tabs.onRemoved.addListener(id => cancelOwner(`tab:${id}`));
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'loading') cancelOwner(`tab:${id}`); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({id: 'qingyi-selection', title: '用墨序翻译所选文字', contexts: ['selection'], documentUrlPatterns: ['http://*/*', 'https://*/*']}));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'qingyi-selection' && info.frameId===0) pageAction(tab.id, 'selection', info.selectionText).catch(() => {});
});
chrome.commands.onCommand.addListener(async name => {
  if (!['toggle-translation','translate-selection'].includes(name)) return;
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab) pageAction(tab.id, name==='translate-selection'?'selection':'toggle').catch(() => {});
});

let floatingSync=Promise.resolve();
function syncFloating() {
  floatingSync=floatingSync.catch(()=>{}).then(updateFloatingRegistration);
  return floatingSync;
}
async function updateFloatingRegistration() {
  const {floatingOrigins=[]}=await chrome.storage.local.get('floatingOrigins');
  const matches=[];
  for(const origin of floatingOrigins) if(await chrome.permissions.contains({origins:[origin]})) matches.push(origin);
  const registered=await chrome.scripting.getRegisteredContentScripts({ids:['qingyi-floating']});
  if(matches.length) {
    const script={id:'qingyi-floating',matches,js:['content.js'],runAt:'document_idle',persistAcrossSessions:true};
    if(registered.length)await chrome.scripting.updateContentScripts([script]);else await chrome.scripting.registerContentScripts([script]);
  } else if(registered.length) await chrome.scripting.unregisterContentScripts({ids:['qingyi-floating']});
}
chrome.permissions.onRemoved.addListener(()=>syncFloating().catch(()=>{}));
accessReady.then(syncFloating).catch(()=>{});

// Permission dialogs may close the popup. Finish the explicit site request in the worker.
chrome.permissions.onAdded.addListener(()=>finishPendingFloat().catch(()=>{}));
async function finishPendingFloat() {
  const {pendingFloat:p}=await chrome.storage.session.get('pendingFloat');
  if(!p || Date.now()-p.at>300000)return;
  const origin=p.origin+'/*';
  if(!await chrome.permissions.contains({origins:[origin]}))return;
  const {floatingOrigins=[]}=await chrome.storage.local.get('floatingOrigins');
  await chrome.storage.local.set({floatingOrigins:[...new Set([...floatingOrigins,origin])]});
  await syncFloating();await chrome.storage.session.remove('pendingFloat');
  const tab=await chrome.tabs.get(p.tabId);
  if(new URL(tab.url).origin===p.origin)await inject(p.tabId);
}
