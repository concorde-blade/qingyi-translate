import {renderMarkdown} from './markdown.js';
import {sourceURLs, publicSourceURL, readRemoteDocument} from './source-reader.js';
import {SEARCH_ORIGINS} from './web-search.js';
import {decideWebSearch} from './assistant-intent.js';
const $ = id => document.getElementById(id);
const id = () => crypto.randomUUID();
const send = message => chrome.runtime.sendMessage(message);
const MODE_LABELS = {chat:'自由问答',summarize:'网页总结',research:'论文精读',explain:'解释概念',translate:'双语翻译',rewrite:'写作润色'};
const MAX_HISTORY = 40, MAX_MESSAGES = 60;
let conversations = [], current, config, attached = null, activeTabId = null, activeTabURL = '', currentWindowId;
let running = null, contextEpoch = 0, historyVisible = false, autoScroll = true, saveChain = Promise.resolve(), progressFrame = null;
const messageNodes = new Map();
let documents = [], readingFiles = false, webEnabled = true, documentEpoch = 0, documentReadController;
current = freshConversation();
let noticeTimer;
function notice(text = '', error = false) { clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').classList.toggle('error', error); if (text && !error) noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 2800); }
function conversationTitle(messages) { return (messages.find(m => m.role === 'user')?.content || '新对话').replace(/\s+/g, ' ').slice(0, 40); }
function freshConversation() { return {id:id(),title:'新对话',updated:Date.now(),model:$('model').value || config?.model || '',messages:[]}; }
const deletedHistoryIds = new Set();
let savedHistoryIds = new Set();
function acceptHistory(history, fromStorage = false) {
  if (!Array.isArray(history)) return;
  if (fromStorage && savedHistoryIds.has(current?.id) && !history.some(c => c.id === current?.id)) {
    deletedHistoryIds.add(current.id);
    notice('这条记录已在其他窗口删除。本窗口内容仍可导出，继续提问将建立新记录。');
  }
  if (fromStorage) savedHistoryIds = new Set(history.map(c => c.id));
  conversations = history;
  if (historyVisible) renderHistory();
}
function persist() {
  if (!current?.messages.length || deletedHistoryIds.has(current.id)) return;
  current.title = conversationTitle(current.messages); current.updated = Date.now(); current.model = $('model').value.trim();
  current.messages = current.messages.slice(-MAX_MESSAGES);
  const snapshot = JSON.parse(JSON.stringify(current));
  const at = conversations.findIndex(c => c.id === current.id);
  if (at < 0) conversations.unshift(current); else conversations[at] = current;
  conversations.sort((a,b) => b.updated - a.updated);
  conversations = conversations.slice(0, MAX_HISTORY);
  // The worker serializes all windows' writes and merges by conversation ID.
  saveChain = saveChain.catch(() => {}).then(async () => {
    if (deletedHistoryIds.has(snapshot.id)) return;
    const result = await send({type:'ASSISTANT_SAVE_CONVERSATION',conversation:snapshot});
    if (result?.code === 'CONVERSATION_DELETED') { deletedHistoryIds.add(snapshot.id); acceptHistory(result.history); notice('这条记录已在其他窗口删除，当前内容仍可导出。继续提问将建立新记录。'); return; }
    if (!result?.ok) throw new Error(result?.error || '对话记录保存失败。');
    acceptHistory(result.history);
  }).catch(() => notice('对话记录保存失败。可先导出当前对话，避免丢失。', true));
  if (historyVisible) renderHistory();
}
function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
  $('send').hidden = busy; $('stop').hidden = !busy;
  $('model').disabled = busy; $('modelPicker').disabled = busy; $('mode').disabled = busy;
  $('addAttachment').disabled = busy || readingFiles; $('webSearchToggle').disabled = busy;
  $('refreshModels').disabled = busy; $('exportChat').disabled = !current?.messages.length;
  for (const b of document.querySelectorAll('[data-task]')) b.disabled = busy;
}
function scrollLatest(force = false) { if (force || autoScroll) $('conversation').scrollTop = $('conversation').scrollHeight; }
$('conversation').addEventListener('scroll', () => {
  const area = $('conversation'); autoScroll = area.scrollHeight - area.scrollTop - area.clientHeight < 90;
  $('jumpLatest').hidden = autoScroll || !current?.messages.length;
}, {passive:true});
$('jumpLatest').onclick = () => { autoScroll = true; scrollLatest(true); };
function sourceSummary(source) { return source ? `${source.title || '已附加网页'}${source.truncated ? ' · 部分正文' : ''}` : ''; }
function appendMessage(message, index) {
  const article = document.createElement('article'); article.className = 'message ' + message.role; article.dataset.messageId = message.id;
  const header = document.createElement('div'); header.className = 'message-header';
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = message.role === 'user' ? '你' : '墨';
  const name = document.createElement('span'); name.textContent = message.role === 'user' ? '你' : '墨序';
  const model = document.createElement('span'); model.className = 'message-model'; model.textContent = message.role === 'assistant' ? message.model || '' : MODE_LABELS[message.mode] || '';
  header.append(avatar, name, model);
  const content = document.createElement('div'); content.className = 'message-content';
  const error = document.createElement('div'); error.className = 'message-error'; error.hidden = true;
  const tools = document.createElement('div'); tools.className = 'message-tools';
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(message.content); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制'; }, 1600); }
    catch { notice('剪贴板暂不可用，请选中回答文字后按 ⌘/Ctrl + C 复制。', true); }
  };
  const state = document.createElement('span'); state.className = 'message-state';
  tools.append(copy, state); article.append(header, content);
  if (message.source) { const source = document.createElement('span'); source.className = 'message-source'; source.textContent = '参考网页 · ' + sourceSummary(message.source); source.title = message.source.url || ''; article.append(source); }
  if (message.files?.length) { const files = document.createElement('span'); files.className = 'message-source'; files.textContent = message.files.join(' · '); article.append(files); }
  if (message.searchSources?.length) {
    const sources = document.createElement('div'); sources.className = 'message-sources';
    for (const [at,item] of message.searchSources.entries()) {
      let url; try { url = publicSourceURL(item.url); } catch { continue; }
      const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = item.title;
      const number = document.createElement('span'); number.className = 'source-number'; number.textContent = String(at + 1);
      const title = document.createElement('span'); title.className = 'source-title'; title.textContent = item.title || new URL(url).hostname;
      link.append(number,title); sources.append(link);
    }
    article.append(sources);
  }
  article.append(error, tools); $('messages').append(article);
  messageNodes.set(message.id, {article,content,error,copy,state,tools,message,index});
  updateMessage(message);
}
function updateMessage(message) {
  const node = messageNodes.get(message.id); if (!node) return;
  node.article.classList.toggle('pending', message.status === 'pending');
  if (message.role === 'user') node.content.textContent = message.content; else renderMarkdown(message.content, node.content);
  node.error.textContent = message.error || ''; node.error.hidden = !message.error;
  node.copy.hidden = !message.content; node.copy.disabled = message.status === 'pending';
  const states = {waiting:'等待模型…',reading:'正在读取…',searching:'正在搜索…',generating:'正在生成…',streaming:'正在生成…'};
  node.state.textContent = message.status === 'pending' ? states[message.phase] || '正在生成…' : message.status === 'stopped' ? '已停止' : message.status === 'error' ? '未完成' : '';
  node.state.classList.toggle('error', message.status === 'error');
  scrollLatest();
}
function renderMessages() {
  messageNodes.clear(); $('messages').replaceChildren();
  $('welcome').hidden = !!current.messages.length;
  current.messages.forEach(appendMessage);
  const last = current.messages.at(-1);
  if (last?.role === 'assistant' && last.status !== 'pending' && current.messages.at(-2)?.role === 'user') {
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试';
    retry.onclick = retryLast; messageNodes.get(last.id).tools.append(retry);
  }
  $('exportChat').disabled = !current.messages.length; scrollLatest();
}
function setHistoryVisible(value) { historyVisible = value; $('historyPanel').hidden = !value; $('historyToggle').setAttribute('aria-expanded', String(value)); if (value) renderHistory(); }
function renderHistory() {
  const query = $('historySearch').value.trim().toLocaleLowerCase(); $('historyList').replaceChildren();
  const matches = conversations.filter(c => !query || c.title.toLocaleLowerCase().includes(query) || c.messages.some(m => m.content.toLocaleLowerCase().includes(query)));
  if (!matches.length) { const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = query ? '没有找到对话' : '暂无记录'; $('historyList').append(empty); return; }
  for (const conversation of matches) {
    const item = document.createElement('div'); item.className = 'history-item' + (conversation.id === current.id ? ' active' : '');
    const button = document.createElement('button'); button.className = 'history-open';
    const title = document.createElement('strong'); title.textContent = conversation.title;
    const detail = document.createElement('small'); detail.textContent = `${new Date(conversation.updated).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} · ${Math.ceil(conversation.messages.length / 2)} 轮对话`;
    button.append(title, detail); button.onclick = () => loadConversation(conversation);
    const remove = document.createElement('button'); remove.className = 'history-delete'; remove.textContent = '×'; remove.title = '删除这条记录'; remove.setAttribute('aria-label', '删除对话：' + conversation.title);
    remove.onclick = async () => {
      if (!confirm(`删除“${conversation.title}”的本机记录？此操作不可撤销，可先导出备份。`)) return;
      deletedHistoryIds.add(conversation.id);
      if (current.id === conversation.id) newConversation();
      try {
        await saveChain;
        const result = await send({type:'ASSISTANT_DELETE_CONVERSATION',conversationId:conversation.id});
        if (!result?.ok) throw new Error(result?.error || '删除记录失败。');
        acceptHistory(result.history); renderHistory();
      } catch (error) { deletedHistoryIds.delete(conversation.id); notice(error.message,true); }
    };
    item.append(button, remove); $('historyList').append(item);
  }
}
function detachPage(text = '') {
  const wasAttached = !!attached;
  contextEpoch++; attached = null; $('contextCard').classList.remove('attached');
  $('attachPage').textContent = '＋ 附加网页'; $('attachPage').setAttribute('aria-pressed','false'); $('attachPage').setAttribute('aria-label','附加网页'); $('attachPage').disabled = false;
  $('refreshContext').hidden = true; $('pageTitle').textContent = ''; $('pageTitle').title = '';
  $('contextDetail').textContent = ''; $('contextDetail').hidden = true; if (wasAttached && text && !running) notice('已取消附加');
}
async function queryActiveTab() {
  const tabs = await chrome.tabs.query(currentWindowId ? {active:true,windowId:currentWindowId} : {active:true,currentWindow:true});
  return tabs[0];
}
async function readContext({quiet = false, signal} = {}) {
  const epoch = ++contextEpoch; const tab = await queryActiveTab();
  if (!tab?.id) throw new Error('没有找到当前网页。请先打开要阅读的网页。');
  $('attachPage').disabled = true;
  if (!quiet) notice('读取网页…');
  try {
    let result;
    if (/\.pdf(?:[?#]|$)/i.test(tab.url || '')) {
      if (quiet && attached?.remote && attached.tabId === tab.id && attached.url === tab.url) return attached;
      const url = publicSourceURL(tab.url);
      const origins = [new URL(url).origin + '/*'];
      if (!await chrome.permissions.request({origins})) throw new Error('需要允许读取此网站的 PDF');
      const pdf = await readRemoteDocument(url,{signal});
      result = {ok:true,tabId:tab.id,context:{...pdf,text:pdf.text.slice(0,24000),truncated:pdf.truncated || pdf.text.length>24000,remote:true}};
    } else result = await send({type:'GET_PAGE_CONTEXT',tabId:tab.id});
    if (!result?.ok) throw new Error(result?.error || '无法读取此页面。请在普通网页中重试。');
    const latest = await queryActiveTab();
    if (epoch !== contextEpoch || latest?.id !== tab.id || (tab.url && latest?.url && latest.url !== tab.url)) throw new Error('网页已经切换，请重新附加当前页面。');
    attached = {tabId:result.tabId || tab.id,...result.context}; activeTabId = tab.id; activeTabURL = latest.url || '';
    $('contextCard').classList.add('attached'); $('attachPage').textContent = '×'; $('attachPage').setAttribute('aria-label','取消附加网页'); $('attachPage').setAttribute('aria-pressed','true');
    $('refreshContext').hidden = false; $('pageTitle').textContent = attached.title || '当前网页'; $('pageTitle').title = attached.url || '';
    $('contextDetail').textContent = attached.truncated ? '已附加部分正文' : ''; $('contextDetail').hidden = !attached.truncated; $('pageTitle').title = `${attached.url || ''} · ${(attached.text || '').length.toLocaleString()} 字`;
    if (!quiet) notice('已附加网页');
    return attached;
  } finally { if (epoch === contextEpoch) $('attachPage').disabled = false; }
}
$('attachPage').onclick = async () => { if (attached) { detachPage(); notice('已取消附加'); return; } try { await readContext(); } catch (e) { detachPage(); notice(e.message,true); } };
$('refreshContext').onclick = async () => { try { await readContext(); } catch (e) { detachPage(); notice(e.message,true); } };
function cleanMessages(messages) {
  const valid = messages.filter(m => ['user','assistant'].includes(m.role) && m.content && (m.role === 'user' || m.status === 'done')).map(m => ({role:m.role,content:m.role === 'assistant' && m.content.length > 24000 ? m.content.slice(0,23950) + '\n[此前回答过长，已截取前半部分作为对话上下文。]' : m.content}));
  let total = 0, kept = [];
  for (let at = valid.length - 1; at >= 0; at--) { const message = valid[at]; if (kept.length >= 40 || total + message.content.length > 48000) break; kept.unshift(message); total += message.content.length; }
  while (kept[0]?.role === 'assistant') kept.shift();
  // Failed assistant replies can leave adjacent user turns; keep the latest question.
  return kept.filter((m,at) => m.role !== 'user' || kept[at + 1]?.role !== 'user');
}
function publicContext(value) { return value ? {title:value.title,url:value.url,text:value.text,truncated:!!value.truncated} : undefined; }
function sourceReference(value) { return value ? {title:value.title,url:value.url,truncated:!!value.truncated} : undefined; }
function renderDocuments() {
  $('attachments').replaceChildren(); $('attachments').hidden = !documents.length;
  for (const document of documents) {
    const chip = window.document.createElement('div'); chip.className = 'attachment-chip';
    const label = window.document.createElement('span'); label.className = 'attachment-name'; label.textContent = document.title; label.title = `${document.title}${document.pages ? ` · ${document.pages} 页` : ''}${document.truncated ? ' · 已截取部分文字' : ''}`;
    const remove = window.document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = '移除文件'; remove.setAttribute('aria-label','移除 '+document.title); remove.disabled = !!running;
    remove.onclick = () => { documents = documents.filter(item => item !== document); renderDocuments(); };
    chip.append(label,remove); $('attachments').append(chip);
  }
}
function updateWebToggle() { $('webSearchToggle').setAttribute('aria-pressed',String(webEnabled)); $('webSearchToggle').title = webEnabled ? '联网已开启 · 点击关闭' : '联网搜索'; }
$('webSearchToggle').onclick = async () => {
  if (!webEnabled && !await chrome.permissions.request({origins:SEARCH_ORIGINS})) { notice('未开启联网权限',true); return; }
  webEnabled = !webEnabled; updateWebToggle(); chrome.storage.local.set({assistantWebEnabled:webEnabled}).catch(() => {});
};
$('addAttachment').onclick = () => $('fileInput').click();
async function addDocuments(files) {
  if (readingFiles || running) return;
  readingFiles = true; setBusy(false); $('send').disabled = true; notice('读取文件…');
  const epoch = ++documentEpoch; documentReadController = new AbortController();
  try {
    const {readLocalDocument} = await import('./document-reader.js');
    for (const file of [...files]) {
      if (documents.length >= 4) throw new Error('一次最多附加 4 个文件');
      const parsed = await readLocalDocument(file,{signal:documentReadController.signal});
      if (epoch !== documentEpoch) return;
      documents.push(parsed); renderDocuments();
    }
    notice(documents.some(d => d.truncated) ? '较长文件已截取部分内容' : '');
  } catch (error) { if (epoch === documentEpoch) notice(error.message,true); }
  finally { readingFiles = false; $('fileInput').value = ''; $('send').disabled = false; setBusy(!!running); }
}
$('fileInput').onchange = () => addDocuments($('fileInput').files);
$('chatForm').addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) {event.preventDefault();event.dataTransfer.dropEffect='copy';} });
$('chatForm').addEventListener('drop', event => { if (event.dataTransfer.files.length) {event.preventDefault();addDocuments(event.dataTransfer.files);} });
function documentPayload(items) {
  const selected = items.slice(0,4), budget = Math.floor(48000 / Math.max(1,selected.length));
  return selected.map(item => { const text = item.text.slice(0,budget); return {title:item.title.slice(0,240),url:item.url || '',kind:item.kind || 'text',text,truncated:item.truncated || text.length<item.text.length}; }).filter(item => item.text);
}
async function prepareRequestAccess(text) {
  const urls = sourceURLs(text), origins = urls.map(url => new URL(url).origin+'/*');
  if (documents.length + urls.filter(url => !documents.some(item => item.url === url)).length > 4) throw new Error('文件与链接合计最多附加 4 份资料');
  const {search} = decideWebSearch({text,enabled:webEnabled,mode:$('mode').value,hasURLs:!!urls.length,hasDocuments:!!documents.length,hasPage:!!attached,messages:current.messages});
  if (search) origins.push(...SEARCH_ORIGINS);
  if (origins.length && !await chrome.permissions.request({origins:[...new Set(origins)]})) throw new Error('未获得联网访问权限。可关闭联网或移除链接后继续');
  return {urls,search};
}
async function runChat(userMessage, {retry = false} = {}) {
  if (running) return;
  const model = $('model').value.trim();
  if (!model) { notice('请填写或选择对话模型。', true); $('model').focus(); return; }
  if (!config?.configured) { notice('请先在服务设置中保存 API 地址、模型和密钥。', true); return; }
  if (deletedHistoryIds.has(current.id)) current = {...current,id:id(),messages:current.messages.map(m => ({...m}))};
  const originalConversation = current;
  const access = await prepareRequestAccess(userMessage.content);
  if (running || current !== originalConversation) return;
  const token = {id:id(),conversation:current,assistant:null,cancelled:false,controller:new AbortController()}; running = token; setBusy(true); renderDocuments(); notice('');
  let context;
  try {
    if (attached) context = await readContext({quiet:true,signal:token.controller.signal});
    if (token.cancelled || running !== token) return;
    if (retry) current.messages.pop(); else current.messages.push(userMessage);
    // Context is a snapshot for this request, not hidden conversation data.
    userMessage.source = sourceReference(context); userMessage.contextRequired = !!context;
    userMessage.files = documents.map(item => item.title);
    const messages = cleanMessages(current.messages);
    const assistant = {id:id(),role:'assistant',content:'',status:'pending',phase:'waiting',model,created:Date.now()};
    token.assistant = assistant; current.messages.push(assistant);
    if (!retry) { $('prompt').value = ''; updateInput(); }
    autoScroll = true; renderMessages(); persist();
    const linked = [];
    for (const url of access.urls) {
      assistant.phase = 'reading'; updateMessage(assistant);
      linked.push(await readRemoteDocument(url,{signal:token.controller.signal}));
    }
    if (running !== token || token.cancelled) return;
    // Keep successfully read links attached for follow-up questions in this session.
    // Explicitly pasting a link again refreshes it; raw content never enters saved history.
    if (linked.length) {
      const refreshed = new Set(linked.map(item => item.url));
      documents = [...documents.filter(item => !refreshed.has(item.url)),...linked];
      userMessage.files = documents.map(item => item.title);
      renderDocuments(); renderMessages(); persist();
    }
    const result = await send({type:'ASSISTANT_CHAT',requestId:token.id,messages,context:publicContext(context),documents:documentPayload(documents),webSearch:access.search,model,mode:userMessage.mode});
    if (running !== token || token.cancelled) return;
    if (!result?.ok) throw new Error(result?.error || '服务没有返回结果，请重试。');
    assistant.content = result.text; assistant.searchSources = result.sources || []; assistant.status = 'done'; assistant.error = ''; notice('');
  } catch (error) {
    if (running !== token || token.cancelled) return;
    if (token.assistant) { token.assistant.status = 'error'; token.assistant.error = error.message || '连接中断，请重试。'; }
    notice(error.message || '连接中断，请重试。', true);
  } finally {
    if (running === token) { running = null; setBusy(false); renderDocuments(); renderMessages(); persist(); }
  }
}
async function retryLast() {
  if (running) return;
  const previous = current.messages.at(-2); if (!previous || previous.role !== 'user') return;
  if (previous.files?.some(title => !documents.some(item => item.title === title))) { notice('请重新附加这条对话使用的文件后再重试',true); return; }
  if (previous.contextRequired && (!attached || previous.source?.url !== attached.url)) { notice('这条回答使用了网页上下文。请先重新附加原网页，再重试；也可在输入框中发起新问题。', true); return; }
  try { await runChat(previous, {retry:true}); } catch (error) { notice(error.message,true); }
}
function stopChat(showNotice = true) {
  const token = running; if (!token) return;
  token.cancelled = true; running = null;
  token.controller?.abort();
  send({type:'ASSISTANT_CANCEL',requestId:token.id}).catch(() => {});
  if (token.assistant) { token.assistant.status = 'stopped'; token.assistant.error = ''; }
  setBusy(false); renderDocuments(); renderMessages(); persist(); if (showNotice) notice('已停止');
}
$('stop').onclick = () => stopChat();
chrome.runtime.onMessage.addListener(message => {
  if (message.type !== 'ASSISTANT_PROGRESS' || !running || message.requestId !== running.id || !running.assistant) return;
  const assistant = running.assistant; assistant.content = typeof message.text === 'string' ? message.text : assistant.content; assistant.phase = message.phase;
  if (!progressFrame) progressFrame = requestAnimationFrame(() => { progressFrame = null; updateMessage(assistant); });
});
$('chatForm').onsubmit = async event => {
  event.preventDefault(); if (running || readingFiles) return;
  const text = $('prompt').value.trim(); if (!text) { $('prompt').focus(); return; }
  if (text.length > 24000) { notice('单次最多发送 24,000 字，请精简内容。',true); return; }
  const message = {id:id(),role:'user',content:text,mode:$('mode').value,created:Date.now(),status:'done'};
  try { await runChat(message); } catch (error) { notice(error.message,true); }
};
const COMPOSER_HEIGHT_KEY = 'assistantComposerHeight';
let preferredComposerHeight = null, composerDrag = null, composerPreferenceChanged = false;
function maxComposerHeight() { return Math.max(30, Math.min(360, Math.floor(window.innerHeight * .45))); }
function clampComposerHeight(height) { return Math.max(30, Math.min(maxComposerHeight(), Math.round(height))); }
function updateInput() {
  const prompt = $('prompt');
  if (preferredComposerHeight === null) {
    prompt.style.height = 'auto';
    prompt.style.height = Math.min(120, maxComposerHeight(), Math.max(30, prompt.scrollHeight)) + 'px';
  } else prompt.style.height = clampComposerHeight(preferredComposerHeight) + 'px';
  const height = Math.round(prompt.getBoundingClientRect().height);
  $('composerResize').setAttribute('aria-valuemax', String(maxComposerHeight()));
  $('composerResize').setAttribute('aria-valuenow', String(height));
  $('composerResize').setAttribute('aria-valuetext', `${height} 像素${preferredComposerHeight === null ? '，自动' : ''}`);
  $('inputCount').textContent = prompt.value.length > 1000 ? prompt.value.length.toLocaleString() + ' / 24,000' : '';
}
function saveComposerHeight() {
  composerPreferenceChanged = true;
  chrome.storage.local.set({[COMPOSER_HEIGHT_KEY]:preferredComposerHeight}).catch(() => notice('输入框尺寸未保存', true));
}
function resetComposerHeight() { preferredComposerHeight = null; updateInput(); saveComposerHeight(); }
const composerResize = $('composerResize');
composerResize.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  composerDrag = {pointerId:event.pointerId,y:event.clientY,height:$('prompt').getBoundingClientRect().height,previous:preferredComposerHeight,moved:false};
  composerResize.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing-composer');
});
composerResize.addEventListener('pointermove', event => {
  if (!composerDrag || event.pointerId !== composerDrag.pointerId) return;
  const delta = composerDrag.y - event.clientY;
  if (!composerDrag.moved && Math.abs(delta) < 2) return;
  composerDrag.moved = true; composerPreferenceChanged = true;
  preferredComposerHeight = clampComposerHeight(composerDrag.height + delta); updateInput();
});
function finishComposerResize(event) {
  if (!composerDrag || event.pointerId !== composerDrag.pointerId) return;
  const drag = composerDrag; composerDrag = null;
  document.body.classList.remove('resizing-composer');
  if (composerResize.hasPointerCapture(event.pointerId)) composerResize.releasePointerCapture(event.pointerId);
  if (event.type === 'pointercancel') { preferredComposerHeight = drag.previous; updateInput(); }
  else if (drag.moved) saveComposerHeight();
}
for (const type of ['pointerup','pointercancel','lostpointercapture']) composerResize.addEventListener(type, finishComposerResize);
composerResize.addEventListener('dblclick', resetComposerHeight);
composerResize.addEventListener('keydown', event => {
  const height = $('prompt').getBoundingClientRect().height, step = event.shiftKey ? 24 : 8;
  if (event.key === 'Enter') { event.preventDefault(); resetComposerHeight(); return; }
  const next = {ArrowUp:height + step,ArrowDown:height - step,Home:30,End:maxComposerHeight()}[event.key];
  if (next === undefined) return;
  event.preventDefault(); preferredComposerHeight = clampComposerHeight(next); updateInput(); saveComposerHeight();
});
window.addEventListener('resize', updateInput);
$('prompt').addEventListener('input', updateInput);
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!running) $('chatForm').requestSubmit(); } });
function clearDocuments() { documentEpoch++; documentReadController?.abort(); documents = []; renderDocuments(); }
function newConversation() { stopChat(false); persist(); clearDocuments(); current = freshConversation(); $('prompt').value = ''; $('mode').value = 'chat'; detachPage(); notice(''); renderMessages(); updateInput(); setHistoryVisible(false); $('prompt').focus(); }
function loadConversation(conversation) { stopChat(false); clearDocuments(); current = conversation; $('model').value = conversation.model || config?.model || ''; $('prompt').value = ''; $('mode').value = 'chat'; detachPage(); notice(''); renderMessages(); updateInput(); setHistoryVisible(false); autoScroll = true; scrollLatest(true); }
$('newChat').onclick = newConversation;
$('historyToggle').onclick = () => setHistoryVisible(!historyVisible);
$('modelPicker').onclick = () => { $('model').focus(); try { $('model').showPicker?.(); } catch {} };
$('closeHistory').onclick = () => setHistoryVisible(false);
$('historySearch').addEventListener('input', renderHistory);
$('settings').onclick = $('setupService').onclick = () => chrome.runtime.openOptionsPage();
$('refreshModels').onclick = async () => {
  $('refreshModels').disabled = true; notice('读取模型…');
  try { const result = await send({type:'MODELS'}); if (!result?.ok) throw new Error(result?.error || '无法读取模型列表。'); $('models').replaceChildren(...result.models.map(model => { const option = document.createElement('option'); option.value = model; return option; })); notice(`已更新 ${result.models.length} 个模型`); }
  catch (error) { notice(error.message, true); } finally { $('refreshModels').disabled = !!running; }
};
$('model').addEventListener('change', () => { if (current) current.model = $('model').value.trim(); notice('已切换对话模型'); });
$('exportChat').onclick = () => {
  if (!current.messages.length) return;
  const body = [`# ${current.title}`, '', `导出时间：${new Date().toLocaleString('zh-CN')}`, '', ...current.messages.flatMap(m => [`## ${m.role === 'user' ? '你' : '墨序'}${m.model ? ' · ' + m.model : ''}`, '', ...(m.source ? [`参考网页：${m.source.title || ''}`, m.source.url || '', ''] : []), ...(m.files?.length ? [`附加资料：${m.files.join('、')}`, ''] : []), m.content || '（没有内容）', ...(m.searchSources?.length ? ['', '参考来源：', ...m.searchSources.map((source,index) => `${index + 1}. ${source.title}\n   ${source.url}`)] : []), ...(m.error ? ['', `未完成：${m.error}`] : []), ...(m.status === 'stopped' ? ['', '（已停止，内容可能未完成）'] : []), ''])].join('\n');
  const url = URL.createObjectURL(new Blob([body],{type:'text/markdown;charset=utf-8'})), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `墨序-${current.title.replace(/[\\/:*?"<>|\r\n]/g,'_').slice(0,45)}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),30000); notice('已导出');
};
for (const button of document.querySelectorAll('[data-task]')) button.onclick = async () => {
  const mode = button.dataset.task; $('mode').value = mode; notice('');
  let page;
  if (!documents.length && ['summarize','research','explain'].includes(mode)) {
    try { page = await readContext({quiet:true}); } catch (error) { detachPage(); notice(error.message + ' 也可以添加文件或粘贴正文。', true); if (['summarize','research'].includes(mode)) return; }
  }
  const selection = page?.selection || attached?.selection || '';
  const prompts = {
    summarize:'请用约300—500字总结当前网页：先用一句话概括主旨，再列出核心观点、关键事实和需要进一步核实的内容。请仅基于可见正文，不把推测当作事实。',
    research:'请精读当前论文内容，先给出约800—1200字的分析，按以下结构组织：研究问题、主要贡献、方法与假设、关键证据、局限性、值得追问的问题。如果当前页面只有摘要，请明确说明哪些信息不足，避免臆测全文。',
    explain:selection ? `请结合网页语境解释以下文字，先用直观语言说明，再给出严谨解释和一个例子：\n\n${selection}` : '请解释我接下来给出的概念：先直观说明，再给出严谨定义、例子与常见误区。\n\n需要解释的概念：',
    translate:selection ? `请将以下文字翻译成${config?.target || '简体中文'}，保留术语、数字、否定和不确定表达：\n\n${selection}` : `请将以下文字翻译成${config?.target || '简体中文'}，保留原意、专业术语和逻辑关系：\n\n`,
    rewrite:'请根据以下要求帮助我写作或润色，保留事实、不编造引用，并说明关键修改。\n\n用途与读者：\n语气与长度：\n原文或要点：',
    chat:''
  };
  $('prompt').value = prompts[mode]; updateInput(); $('prompt').focus();
  if (!['summarize','research','explain'].includes(mode) || page) notice('');
};
for (const button of document.querySelectorAll('[data-page-action]')) button.onclick = async () => {
  if (button.disabled) return; button.disabled = true;
  try { const tab = await queryActiveTab(); if (!tab?.id) throw new Error('没有找到当前网页。'); const result = await send({type:'PAGE',tabId:tab.id,action:button.dataset.pageAction}); if (!result?.ok) throw new Error(result?.error || '无法操作当前网页。'); notice(button.dataset.pageAction === 'restore' ? '已恢复原文' : '已开始翻译'); }
  catch (error) { notice(error.message,true); } finally { button.disabled = false; }
};
async function refreshConfig() {
  const previous = config;
  const result = await send({type:'GET_ASSISTANT_CONFIG'}); if (!result?.ok) throw new Error(result?.error || '无法读取服务设置。');
  config = result;
  const serviceChanged = previous && config.endpoint !== previous.endpoint;
  if (serviceChanged) $('models').replaceChildren();
  if (serviceChanged || !$('model').value || $('model').value === previous?.model) $('model').value = config.model || '';
  let hostname = ''; try { hostname = new URL(config.endpoint).hostname; } catch {}
  $('serviceName').textContent = hostname === 'api.llm.ustc.edu.cn' ? 'USTC' : hostname === 'api.deepseek.com' ? 'DeepSeek' : hostname === 'api.openai.com' ? 'OpenAI' : hostname || '未配置';
  $('serviceName').title = hostname; $('serviceDot').classList.toggle('connected',!!config.configured);
  $('setupNotice').hidden = !!config.configured;
  if (config.model && ![...$('models').options].some(o => o.value === config.model)) { const option = document.createElement('option'); option.value = config.model; $('models').append(option); }
}
chrome.tabs.onActivated.addListener(info => { if (info.windowId !== currentWindowId) return; if (activeTabId !== info.tabId) { activeTabId = info.tabId; activeTabURL = ''; detachPage('网页已切换。重新附加后，后续问题才会读取新页面。'); } });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (tabId !== activeTabId) return; if (change.status === 'loading' || (change.url && change.url !== activeTabURL)) { activeTabURL = change.url || ''; detachPage('网页内容已更新，请重新附加当前页面。'); } });
chrome.storage.onChanged.addListener((changes,area) => { if (area !== 'local') return; if (changes.settings) refreshConfig().catch(error => notice(error.message,true)); if (changes.assistantHistory) acceptHistory(changes.assistantHistory.newValue || [], true); });
window.addEventListener('pagehide', () => { if (running) { send({type:'ASSISTANT_CANCEL',requestId:running.id}).catch(() => {}); if (running.assistant) running.assistant.status = 'stopped'; persist(); } });
async function initialize() {
  try {
    const win = await chrome.windows.getCurrent(); currentWindowId = win.id;
    const tab = await queryActiveTab(); activeTabId = tab?.id; activeTabURL = tab?.url || '';
    await refreshConfig();
    const local = await chrome.storage.local.get(['assistantHistory',COMPOSER_HEIGHT_KEY,'assistantWebEnabled']);
    webEnabled = local.assistantWebEnabled !== false; updateWebToggle();
    const stored = local.assistantHistory;
    if (!composerPreferenceChanged && Number.isFinite(local[COMPOSER_HEIGHT_KEY]) && local[COMPOSER_HEIGHT_KEY] >= 30) preferredComposerHeight = Math.min(360, local[COMPOSER_HEIGHT_KEY]);
    if (Array.isArray(stored)) conversations = stored.slice(0,MAX_HISTORY).filter(c => typeof c?.id === 'string' && Array.isArray(c.messages)).map(c => ({id:c.id,title:String(c.title || '未命名对话').slice(0,100),updated:Number(c.updated) || Date.now(),model:String(c.model || '').slice(0,160),messages:c.messages.slice(-MAX_MESSAGES).filter(m => ['user','assistant'].includes(m?.role) && typeof m.content === 'string').map(m => ({...m,id:typeof m.id === 'string' ? m.id : id(),content:m.content.slice(0,100000),status:m.status === 'pending' ? 'stopped' : m.status || 'done'}))}));
    savedHistoryIds = new Set(conversations.map(c => c.id));
  } catch (error) { notice(error.message || '初始化失败，请重新打开侧边栏。',true); }
  current = freshConversation(); renderMessages(); setBusy(false); updateInput();
}
initialize();

// Keep secondary actions out of the reading area, while retaining keyboard access.
$('moreMenu').addEventListener('click', event => { if (event.target.closest('button')) $('moreMenu').open = false; });
document.addEventListener('click', event => { if (!$('moreMenu').contains(event.target)) $('moreMenu').open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('moreMenu').open = false; });
