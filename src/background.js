import {LOCAL_SETTINGS} from './local-settings.js';
import {DEFAULTS, validateSettings, endpointURL, splitText, requestTranslation, RequestQueue, TranslateError, httpError, RateGate} from './core.js';

// Credentials are accessible only to extension pages and this worker, never content scripts.
const accessReady = (async()=>{
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  if(LOCAL_SETTINGS && !(await chrome.storage.local.get('settings')).settings) {
    await chrome.storage.local.set({settings:validateSettings(LOCAL_SETTINGS)});
  }
  const saved=(await chrome.storage.local.get('settings')).settings;
  if(saved && (saved.concurrency!==1 || !saved.requestInterval)) {
    await chrome.storage.local.set({settings:{...saved,concurrency:1,requestInterval:saved.requestInterval||4000}});
  }
})();
const queue = new RequestQueue(1);
const gateReady=(async()=>new RateGate((await chrome.storage.session.get('rateState')).rateState, {
  persist: rateState=>chrome.storage.session.set({rateState})
}))();
const requests = new Map();
const cache = new Map();
let configVersion = 0;
async function settings() { await accessReady; return validateSettings((await chrome.storage.local.get('settings')).settings || DEFAULTS); }
function safeError(error) { return {ok: false, error: error instanceof TranslateError ? error.message : '扩展连接中断，请刷新网页后重试。', code: error.code || 'INTERNAL', retryAt: Number(error.retryAt) || 0}; }
function owner(sender) { return sender.tab ? `tab:${sender.tab.id}` : 'settings'; }
function cancelOwner(prefix, runId) {
  for (const [id, r] of requests) if (r.owner === prefix && (!runId || r.runId === runId)) { r.controller.abort(); requests.delete(id); }
}
async function translate(message, sender) {
  const s = await settings();
  const url = endpointURL(s.endpoint);
  if (!await chrome.permissions.contains({origins: [`${url.origin}/*`]})) throw new TranslateError('尚未授权访问翻译接口，请打开设置后点击“保存并授权”。', 'PERMISSION');
  const text = String(message.text || '').trim();
  if (!text || text.length > 16000) throw new TranslateError('请选择 1 到 16000 字符的文本。', 'TEXT_SIZE');
  const context = {title: String(message.context?.title || '').slice(0, 240), before: String(message.context?.before || '').slice(-1200), after: String(message.context?.after || '').slice(0, 1200)};
  // Do not store keys in cache indexes; clear the session cache whenever settings change.
  const version = configVersion;
  const key = JSON.stringify([version, s.endpoint, s.model, s.target, s.domain, s.glossary, text, context]);
  if (cache.has(key)) return {ok: true, text: cache.get(key), cached: true};
  const id = crypto.randomUUID();
  const record = {owner: owner(sender), runId: String(message.runId || ''), controller: new AbortController()};
  if (requests.size >= 48) throw new TranslateError('等待翻译的任务较多，请稍后再试。', 'BUSY');
  requests.set(id, record);
  try {
    const result = await queue.run(async () => {
      const chunks = splitText(text);
      const translated = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkContext={...context, before: i ? chunks[i-1].slice(-1200) : context.before, after: i+1 < chunks.length ? chunks[i+1].slice(0,1200) : context.after};
        const chunkKey=JSON.stringify(['chunk',version,s.endpoint,s.model,s.target,s.domain,s.glossary,chunks[i],chunkContext]);
        if(cache.has(chunkKey)){translated.push(cache.get(chunkKey));continue;}
        const gate=await gateReady;
        try {
          const value=await requestTranslation(chunks[i],chunkContext,s,{signal:record.controller.signal,beforeAttempt:signal=>gate.before(signal,s.requestInterval)});
          await gate.success(); translated.push(value);
          if(version===configVersion){cache.set(chunkKey,value);if(cache.size>300)cache.delete(cache.keys().next().value);}
        } catch(error) {
          if(error.code==='HTTP_429') throw await gate.limited(error,s.requestInterval);
          throw error;
        }
      }
      return translated.join('\n');
    }, record.controller.signal);
    if (record.controller.signal.aborted) throw new TranslateError('已停止翻译。', 'CANCELLED');
    if (version === configVersion) { cache.set(key, result); if (cache.size > 300) cache.delete(cache.keys().next().value); }
    return {ok: true, text: result, cached: false};
  } finally { requests.delete(id); }
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({target: {tabId}, files: ['content.js']}); }
  catch { throw new TranslateError('此页面无法使用扩展。请在普通网页中操作；浏览器设置、应用商店和内置 PDF 页面不支持。', 'PAGE_RESTRICTED'); }
}
async function pageAction(tabId, action, text) {
  if (!Number.isInteger(tabId)) throw new TranslateError('没有找到当前网页。', 'PAGE_RESTRICTED');
  await inject(tabId);
  return chrome.tabs.sendMessage(tabId, {type: 'PAGE_ACTION', action, text});
}
const internalPage = sender => !sender.tab && sender.url?.startsWith(chrome.runtime.getURL('')) || sender.url?.startsWith(chrome.runtime.getURL('options.html')) || sender.url?.startsWith(chrome.runtime.getURL('popup.html'));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    const internal = internalPage(sender);
    if (message.type === 'TRANSLATE') {
      if (!internal && (!sender.tab || !/^https?:/.test(sender.url || '') || sender.frameId !== 0)) throw new TranslateError('当前页面不受支持。', 'PAGE_RESTRICTED');
      return translate(message, sender);
    }
    if (message.type === 'CANCEL') { cancelOwner(owner(sender), message.runId); return {ok: true}; }
    if (!internal) throw new TranslateError('操作不可用。', 'FORBIDDEN');
    if(message.type==='PREPARE_FLOAT') {
      const origin=new URL(message.origin).origin;
      const tab=await chrome.tabs.get(message.tabId);
      if(!/^https?:/.test(origin) || new URL(tab.url).origin!==origin)throw new TranslateError('请选择当前网页。','PAGE_RESTRICTED');
      await chrome.storage.session.set({pendingFloat:{origin,tabId:message.tabId,at:Date.now()}});
      return {ok:true};
    }
    if(message.type==='FLOAT_SITE') {
      const origin=new URL(message.origin).origin+'/*';
      if(!/^https?:/.test(origin) || !await chrome.permissions.contains({origins:[origin]})) throw new TranslateError('请先授权当前网站。','PERMISSION');
      const {floatingOrigins=[]}=await chrome.storage.local.get('floatingOrigins');
      await chrome.storage.local.set({floatingOrigins:[...new Set([...floatingOrigins,origin])]});
      await syncFloating(); await chrome.storage.session.remove('pendingFloat');await inject(message.tabId); return {ok:true};
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
    if (message.type === 'GET_SETTINGS') { await accessReady; const saved=(await chrome.storage.local.get('settings')).settings; return {ok:true,settings:{...DEFAULTS,...saved,concurrency:1,requestInterval:Math.max(4000,Number(saved?.requestInterval)||4000)}}; }
    throw new TranslateError('不支持的操作。', 'UNKNOWN_ACTION');
  })().then(respond).catch(error => respond(safeError(error)));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) { configVersion++; cache.clear(); for (const r of requests.values()) r.controller.abort(); }
});
chrome.tabs.onRemoved.addListener(id => cancelOwner(`tab:${id}`));
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'loading') cancelOwner(`tab:${id}`); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({id: 'qingyi-selection', title: '用清译翻译所选文字', contexts: ['selection'], documentUrlPatterns: ['http://*/*', 'https://*/*']}));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'qingyi-selection') pageAction(tab.id, 'selection', info.selectionText).catch(() => {});
});
chrome.commands.onCommand.addListener(async name => {
  if (name !== 'toggle-translation') return;
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab) pageAction(tab.id, 'toggle').catch(() => {});
});

async function syncFloating() {
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
