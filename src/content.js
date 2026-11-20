(() => {
  if (globalThis.__qingyi) return;
  globalThis.__qingyi = true;
  const selector = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,div,section';
  const blockSelector = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,div,section,ul,ol,table';
  const excluded = 'script,style,noscript,pre,code,textarea,input,select,button,a,nav,aside,header,footer,form,[role=button],[role=navigation],[role=banner],[role=contentinfo],[role=toolbar],[role=menu],[role=dialog],svg,math,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[aria-hidden="true"],[hidden],[data-qingyi]';
  let enabled = false, generation = 0, observer, intersection, scanTimer, panel, panelBody, panelCount;
  let running = 0, pageConcurrency=1, maxReached = false, paused = false, dormant = false;
  const records = new Map(), pending = [];
  // randomUUID is unavailable on ordinary HTTP pages in some Chrome versions.
  const newId=()=>crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].map(n=>n.toString(16)).join('-');
  const fatalCodes = new Set(['CONFIG','PERMISSION','HTTP_400','HTTP_401','HTTP_402','HTTP_403','HTTP_404','QUOTA_EXHAUSTED','DISCONNECTED']);
  let fatal = false, cooldownUntil=0, cooldownTimer, ball;
  const send = async message => {
    try {
      const result = await chrome.runtime.sendMessage(message);
      if (!result || typeof result !== 'object') throw new Error('No response');
      return result;
    }
    catch { return {ok: false, error: '扩展连接中断，请刷新网页后重试。', code: 'DISCONNECTED'}; }
  };
  // A list item / table cell owns its translation host. Never read our UI back as source.
  const sourceText = el => {
    function read(node) {
      if(node.nodeType===Node.TEXT_NODE)return node.data;
      if(node.nodeType!==Node.ELEMENT_NODE || node.matches('[data-qingyi],[hidden],[aria-hidden="true"],script,style,noscript'))return '';
      const style=getComputedStyle(node);
      if(style.display==='none' || style.visibility==='hidden')return '';
      if(node.tagName==='BR')return '\n';
      return [...node.childNodes].map(read).join('');
    }
    return read(el).trim();
  };
  function eligible(el) {
    if (el.closest(excluded) || el.querySelector('input,textarea,select,button,pre,code,math,[contenteditable]:not([contenteditable="false"])')) return false;
    if (el.querySelector(blockSelector)) return false;
    const text = sourceText(el);
    if (text.length < 2 || !/\p{L}/u.test(text) || text.length > 16000) return false;
    if (['DIV','SECTION'].includes(el.tagName) && text.length < 50 && !el.closest('article,main,[role=main]')) return false;
    const linkText=[...el.querySelectorAll('a')].reduce((sum,a)=>sum+sourceText(a).length,0);
    if(linkText>text.length*.65 && !el.closest('article,main,[role=main]')) return false;
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }
  function safeNeighbor(el) {
    if (!el || el.closest(excluded) || el.querySelector('input,textarea,select,button,pre,code,math,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]')) return '';
    return sourceText(el).slice(0,1200);
  }
  function contextFor(el) {
    let prev = el?.previousElementSibling, next = el?.nextElementSibling;
    while (prev?.hasAttribute('data-qingyi')) prev = prev.previousElementSibling;
    while (next?.hasAttribute('data-qingyi')) next = next.nextElementSibling;
    return {title: document.title, before: safeNeighbor(prev), after: safeNeighbor(next)};
  }
  function button(text, fn, container) {
    const b = document.createElement('button'); b.textContent = text; b.type = 'button';
    // The page can see the open shadow tree, but may not synthesize translation clicks.
    b.addEventListener('click',event=>{if(event.isTrusted)fn(event);});container.append(b);return b;
  }
  function ensurePanel() {
    if (panel?.isConnected) {panel.shadowRoot.querySelector('.card').hidden=false;panel.shadowRoot.querySelector('.compact').hidden=true;return;}
    panel = document.createElement('div'); panel.setAttribute('data-qingyi', 'panel');
    for(const [key,value] of Object.entries({all:'initial',position:'fixed',right:'22px',bottom:'22px','z-index':'2147483647',display:'block','max-width':'calc(100vw - 32px)'}))panel.style.setProperty(key,value,'important');
    const root = panel.attachShadow({mode:'open'});
    const style = document.createElement('style'); style.textContent = `
      :host{color-scheme:light}*{box-sizing:border-box}.card{width:340px;max-width:calc(100vw - 32px);background:#f6f3ee;color:#292827;font:14px/1.6 Optima,"Hiragino Sans GB","PingFang SC",system-ui,sans-serif;border:1px solid #e2dcd4;border-radius:16px;box-shadow:0 12px 48px #29282730;padding:16px}.head{display:flex;justify-content:space-between;align-items:center;font-weight:650;font-size:16px}.count{font:12px/1.6 Optima,"Hiragino Sans GB","PingFang SC",system-ui,sans-serif;color:#827c74;margin:8px 0}.body{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}button{font:12px Optima,"Hiragino Sans GB","PingFang SC",system-ui,sans-serif;border:1px solid #e1dbd3;border-radius:7px;padding:6px 10px;background:white;color:#292827;cursor:pointer}button:hover{background:#e9e4dd}button:focus-visible{outline:2px solid #9f876c} .head button{border:0;background:transparent;padding:0 4px;font-size:18px}.compact button{background:#f6f3ee;border:1px solid #e1dbd3;box-shadow:0 4px 18px #29282720;padding:9px 14px;font-size:13px}[hidden]{display:none!important}`;
    const card = document.createElement('section'); card.className = 'card'; card.setAttribute('aria-label','墨序翻译面板');
    const head = document.createElement('div'); head.className = 'head'; const title = document.createElement('span'); title.textContent='墨序'; head.append(title);
    button('−', () => {card.hidden=true;compact.hidden=!dormant && !!ball?.isConnected;}, head).setAttribute('aria-label','收起面板');
    const compact=document.createElement('div'); compact.className='compact';compact.hidden=true;
    button('墨序 · 展开',()=>{card.hidden=false;compact.hidden=true;},compact);
    root.append(compact);
    panelCount = document.createElement('div'); panelCount.className = 'count'; panelCount.setAttribute('aria-live','polite');
    panelBody = document.createElement('div'); panelBody.className = 'body';
    const actions = document.createElement('div'); actions.className = 'actions';
    button('翻译网页', start, actions); button('翻译所选文字',()=>selection(),actions);
    button('暂停翻译',()=>{if(!enabled)return;paused=!paused;pauseButton.textContent=paused?'继续翻译':'暂停翻译';if(!paused)pump();progress();},actions).className='pause';
    const pauseButton=actions.querySelector('.pause');
    pauseButton.disabled=!enabled;pauseButton.textContent=paused?'继续翻译':'暂停翻译';
    button('重试失败', retryFailed, actions); button('恢复原文', ()=>restore(), actions);
    button('翻译设置',()=>send({type:'OPEN_OPTIONS'}),actions);
    button('AI 助手侧栏',async()=>{const result=await send({type:'OPEN_ASSISTANT'});if(!result.ok)panelBody.textContent=result.error;},actions);
    card.addEventListener('pointerdown',event=>{if(event.target.closest('button'))event.preventDefault();});
    card.append(head,panelCount,panelBody,actions); root.append(style,card); document.documentElement.append(panel);
  }
  function progress() {
    if (!panelCount || !enabled) return;
    const all=[...records.values()];
    const pauseButton=panel?.shadowRoot?.querySelector('.pause');
    if(pauseButton){pauseButton.disabled=false;pauseButton.textContent=paused?'继续翻译':'暂停翻译';}
    panelCount.textContent = `${paused?'已暂停 · ':''}${all.filter(r=>r.state==='done').length} 段已译 · ${all.filter(r=>r.state==='running'||r.state==='queued').length} 段进行中 · ${all.filter(r=>r.state==='error').length} 段失败 · ${all.filter(r=>r.state==='waiting').length} 段待阅读${all.some(r=>r.state==='unchanged')?' · '+all.filter(r=>r.state==='unchanged').length+' 段无需变更':''}${maxReached?' · 已达本页 400 段上限':''}`;
  }
  function makeTranslation(el) {
    const host = document.createElement('span'); host.setAttribute('data-qingyi', 'translation');
    const sourceStyle=getComputedStyle(el);
    // Sibling insertion must inherit the paragraph's typography, not a white/transparent parent.
    const color=sourceStyle.color==='rgba(0, 0, 0, 0)'?'CanvasText':sourceStyle.color;
    const fontSize=Math.min(24,Math.max(14,parseFloat(sourceStyle.fontSize)||16))+'px';
    const properties={all:'initial',display:'block',margin:'8px 0 14px',color,'font-size':fontSize,'font-family':'Optima,"Hiragino Sans GB","PingFang SC",system-ui,sans-serif','font-weight':'400','line-height':'1.8','text-align':sourceStyle.textAlign,'-webkit-text-fill-color':color,visibility:'visible',opacity:'1','max-width':'100%'};
    for(const [key,value] of Object.entries(properties))host.style.setProperty(key,value,'important');
    const root = host.attachShadow({mode:'open'});
    const style = document.createElement('style'); style.textContent = ':host{color-scheme:light dark}.text{border-left:2px solid #b6a489;padding:5px 0 5px 12px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.8;color:inherit;-webkit-text-fill-color:currentColor;opacity:1}.error{color:#b15742;font-size:13px}button{font-family:inherit;background:transparent;color:inherit;border:1px solid currentColor;border-radius:5px;margin-left:8px;padding:2px 7px;cursor:pointer}';
    const output = document.createElement('div'); output.className='text'; output.textContent='正在翻译…';
    root.append(style,output); if (['TD','TH','LI','BODY','HTML','A'].includes(el.tagName)) el.append(host); else el.after(host); return {host,output};
  }
  function enqueue(record) {
    if (!enabled || fatal || record.state !== 'waiting' || !record.el.isConnected) return;
    record.state='queued'; intersection?.unobserve(record.el); pending.push(record); pump();
  }
  function pump() {
    while (enabled && !paused && !fatal && Date.now()>=cooldownUntil && running < pageConcurrency && pending.length) {
      const record = pending.shift(); if (!record.el.isConnected || records.get(record.el)!==record) continue;
      translateRecord(record);
    }
    progress();
  }
  async function translateRecord(record) {
    const current = generation;
    running++; record.state='running';
    if (!record.host?.isConnected) Object.assign(record,makeTranslation(record.el));
    record.output.className='text'; record.output.textContent='正在翻译…';
    try {
      const result = await send({type:'TRANSLATE', text:record.text, context:contextFor(record.el), runId:record.id});
      if (current !== generation || !enabled || records.get(record.el) !== record || !record.el.isConnected) return;
      if (sourceText(record.el) !== record.text) { record.host.remove(); records.delete(record.el); scheduleScan(); return; }
      if (result.ok) {
        if(result.text.replace(/\s+/g,'')===record.text.replace(/\s+/g,'')){record.state='unchanged';record.host.remove();}
        else {record.state='done';record.output.textContent=result.text;}
      }
      else if(result.code==='RATE_LIMIT' && (record.rateRetries||0)<3) {
        record.rateRetries=(record.rateRetries||0)+1; record.state='queued';pending.unshift(record);
        record.output.textContent='服务限流，等待自动恢复…';
        waitForRate(result.retryAt);
      }
      else {
        record.state='error'; record.output.className='text error'; record.output.textContent=result.error;
        button('重试',()=> { if(record.state!=='error')return;fatal=false;record.rateRetries=0;record.state='waiting';enqueue(record); },record.output);
        if (fatalCodes.has(result.code) || result.code==='RATE_LIMIT') { fatal=true; ensurePanel(); panelBody.textContent=result.error+(result.code==='RATE_LIMIT'?'\n连续限流已暂停。稍后点击“重试失败”。':'\n处理后点击“重试失败”。'); }
      }
    } finally { if (current === generation) { running--; pump(); } }
  }
  function scan() {
    if (!enabled) return;
    for (const [el, r] of records) {
      if (!el.isConnected || sourceText(el)!==r.text) { intersection?.unobserve(el); r.host?.remove();send({type:'CANCEL',runId:r.id});records.delete(el);const i=pending.indexOf(r);if(i>=0)pending.splice(i,1); }
    }
    for (const el of document.querySelectorAll(selector)) {
      if (records.size >= 400) { maxReached=true; break; }
      if (records.has(el) || !eligible(el)) continue;
      const record={id:newId(),el,text:sourceText(el),state:'waiting'}; records.set(el,record); intersection.observe(el);
    }
    progress();
  }
  function scheduleScan() { clearTimeout(scanTimer); scanTimer=setTimeout(scan,350); }
  function retryFailed() {
    if (!enabled) return;
    if(Date.now()<cooldownUntil)return;
    fatal=false; ensurePanel(); panelBody.textContent='随阅读翻译段落。API 服务可能按用量计费。';
    for (const r of records.values()) {
      if (r.state==='error') {r.rateRetries=0;r.state='waiting'; enqueue(r);}
      else if(r.state==='waiting') {intersection.unobserve(r.el);intersection.observe(r.el);}
    }
    pump();
  }
  function nativeTranslationActive() { return document.documentElement.matches('.translated-ltr,.translated-rtl'); }
  function nativeConflict() {
    restore();ensurePanel();panelCount.textContent='检测到浏览器整页翻译';
    panelBody.textContent='Chrome 已经改写了网页原文。请点击地址栏旁的翻译按钮，切回原语言，再使用墨序。';
  }
  function start() {
    if(nativeTranslationActive()){nativeConflict();return;}
    if (enabled) {ensurePanel();progress();return;}
    enabled=true;paused=false;fatal=false;maxReached=false;generation++;running=0;
    ensurePanel(); panelBody.textContent='随阅读翻译段落。API 服务可能按用量计费。';
    intersection=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){const r=records.get(e.target);if(r)enqueue(r);}}),{rootMargin:'0px'});
    observer=new MutationObserver(mutations=> {
      if(nativeTranslationActive()){nativeConflict();return;}
      if (mutations.some(m=>!m.target.closest?.('[data-qingyi]') && !(m.type==='childList' && [...m.addedNodes,...m.removedNodes].every(n=>n.nodeType===1 && n.hasAttribute('data-qingyi'))))) scheduleScan();
    });
    observer.observe(document.body,{childList:true,subtree:true,characterData:true}); observer.observe(document.documentElement,{attributes:true,attributeFilter:['class']}); scan();
  }
  function restore(showBall=true) {
    for(const record of selections.values())closeSelection(record);
    savedSelection=null;hideToolbar();
    enabled=false;paused=false;generation++;running=0;
    observer?.disconnect(); intersection?.disconnect(); clearTimeout(scanTimer); clearTimeout(cooldownTimer);cooldownUntil=0; pending.length=0;
    for (const r of records.values()) {r.host?.remove();send({type:'CANCEL',runId:r.id});}records.clear();panel?.remove();
    if(showBall)ensureBall();
  }
  const selections=new Map();
  const selectionExcluded='script,style,noscript,pre,code,textarea,input,select,button,svg,math,[contenteditable]:not([contenteditable="false"]),[role=textbox],[aria-hidden="true"],[hidden],[data-qingyi]';
  let savedSelection=null,toolbar,selectionTimer,selectionToolbar=true;
  const elementFor=node=>node?.nodeType===1?node:node?.parentElement;
  function captureSelection() {
    const selected=window.getSelection();
    if(!selected?.rangeCount || selected.isCollapsed || !selected.toString().trim())return null;
    const range=selected.getRangeAt(0).cloneRange();
    const common=elementFor(range.commonAncestorContainer);
    if(!common || common.closest(selectionExcluded))return null;
    // Triple-click and Shift+Down may leave the endpoint at offset 0 of the next paragraph.
    // Anchor to the last character actually selected, rather than that empty endpoint.
    const walker=document.createTreeWalker(common,NodeFilter.SHOW_TEXT),nodes=[];
    let node;
    while((node=walker.nextNode())) {
      if(!range.intersectsNode(node))continue;
      const from=node===range.startContainer?range.startOffset:0;
      const to=node===range.endContainer?range.endOffset:node.length;
      if(node.data.slice(from,to).trim())nodes.push(node);
    }
    if(!nodes.length)return null;
    const first=nodes[0],last=nodes.at(-1);
    range.setStart(first,first===range.startContainer?range.startOffset:0);
    range.setEnd(last,last===range.endContainer?range.endOffset:last.length);
    if(nodes.some(node=>{
      const el=elementFor(node),style=getComputedStyle(el);
      return el.closest(selectionExcluded) || !el.getClientRects().length || style.visibility==='hidden';
    }))return null;
    // Reject mixed selections that cross an editor, code area, hidden content or our own UI.
    for(const node of common.querySelectorAll(selectionExcluded))if(range.intersectsNode(node))return null;
    const anchor=elementFor(last)?.closest(selector+',article,main') || common;
    const text=selected.toString().trim();
    const sources=[...new Set(nodes.map(node=>elementFor(node).closest(selector+',article,main') || common))].map(el=>({el,text:sourceText(el)}));
    return {text,range,anchor,sources,anchorText:sourceText(anchor),context:{...contextFor(anchor),before:safeNeighbor(anchor)}};
  }
  function hideToolbar(){toolbar?.remove();toolbar=null;}
  function positionToolbar() {
    if(!toolbar?.isConnected || !savedSelection?.anchor.isConnected)return;
    const rects=[...savedSelection.range.getClientRects()];
    const rect=rects.at(-1);
    if(!rect || rect.bottom<0 || rect.top>innerHeight){hideToolbar();return;}
    const box=toolbar.getBoundingClientRect();
    toolbar.style.setProperty('left',Math.max(8,Math.min(innerWidth-box.width-8,rect.right-box.width))+'px','important');
    const top=rect.bottom+8+box.height<innerHeight?rect.bottom+8:rect.top-box.height-8;
    toolbar.style.setProperty('top',Math.max(8,top)+'px','important');
  }
  function updateSelection() {
    if(dormant)return;
    // A click inside our shadow UI must not discard the saved page range.
    if(document.activeElement?.closest?.('[data-qingyi]'))return;
    const snapshot=captureSelection();
    savedSelection=snapshot;
    hideToolbar();
    if(!snapshot || !selectionToolbar || snapshot.text.length>16000)return;
    toolbar=document.createElement('div');toolbar.setAttribute('data-qingyi','selection-toolbar');
    for(const [key,value] of Object.entries({all:'initial',position:'fixed','z-index':'2147483647',display:'block',left:'8px',top:'8px'}))toolbar.style.setProperty(key,value,'important');
    const root=toolbar.attachShadow({mode:'open'}),style=document.createElement('style');
    style.textContent=':host{color-scheme:light}button{font:600 13px/1.4 Optima,"Hiragino Sans GB","PingFang SC",system-ui,sans-serif;color:#fff;background:#292827;border:1px solid #d6c5aa;border-radius:9px;padding:9px 13px;box-shadow:0 4px 20px #29282730;cursor:pointer}button:hover{background:#45413b}button:focus-visible{outline:3px solid #d6c5aa;outline-offset:2px}';
    root.append(style);
    const b=button('译 · 翻译所选文字',()=>selection(undefined,snapshot),root);
    b.setAttribute('aria-label','翻译选中文字，在原文下方显示');
    b.addEventListener('pointerdown',event=>event.preventDefault());
    document.documentElement.append(toolbar);positionToolbar();
  }
  function closeSelection(record) {
    record.epoch++;record.state='closed';record.cancelWait?.();
    send({type:'CANCEL',runId:record.id});record.host?.remove();selections.delete(record.id);
    if(!selections.size)selectionObserver.disconnect();
  }
  async function copyTranslation(record,b) {
    if(!record.result)return;
    try {
      await navigator.clipboard.writeText(record.result);b.textContent='已复制';
    } catch {
      // Some ordinary HTTP pages have no clipboard API. Let the user copy a selected result.
      if(record.output){const range=document.createRange();range.selectNodeContents(record.output);const selected=getSelection();selected.removeAllRanges();selected.addRange(range);}
      b.textContent='请按 Ctrl / ⌘ + C';
    }
    setTimeout(()=>{b.textContent='复制译文';},1800);
  }
  function selectionCard(record) {
    const {host,output}=makeTranslation(record.anchor);host.setAttribute('data-qingyi','selection');
    const root=host.shadowRoot,style=document.createElement('style');
    style.textContent='.selection-card{border:1px solid #c8bbaa;border-radius:12px;padding:12px 14px;background:#f6f3ee;color:#292827;font:15px/1.8 Optima,"Hiragino Sans GB","PingFang SC",system-ui,sans-serif;box-shadow:0 2px 8px #2928270c}.meta{display:flex;gap:10px;align-items:center;font:12px/1.6 Optima,"Hiragino Sans GB","PingFang SC",system-ui,sans-serif;color:#82796f;margin-bottom:7px}.label{flex:1}.text{border:0;padding:0}.tools{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}button{font:12px/1.5 Optima,"Hiragino Sans GB","PingFang SC",system-ui,sans-serif;margin:0;padding:4px 9px;border:1px solid #c8bbaa;border-radius:6px;color:inherit}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:2px solid #b6a489;outline-offset:2px}.meta button{border:0;font-size:17px;padding:0 4px}.selection-card *{-webkit-text-fill-color:currentColor}.error{color:#a24030}[hidden]{display:none!important}@media(prefers-color-scheme:dark){.selection-card{background:#252321;color:#f0e9df}.meta{color:#c4b9aa}.error{color:#ffb49e}}';
    const card=document.createElement('section');card.className='selection-card';card.setAttribute('aria-label','所选文字的译文');
    const meta=document.createElement('div');meta.className='meta';
    const status=document.createElement('span');status.className='label';status.textContent='墨序 · 所选文字';meta.append(status);
    button('×',()=>closeSelection(record),meta).setAttribute('aria-label','关闭这条译文');
    const tools=document.createElement('div');tools.className='tools';
    const copy=button('复制译文',event=>copyTranslation(record,event.currentTarget),tools);copy.disabled=true;
    const retry=button('重试翻译',()=>runSelection(record),tools);retry.hidden=true;
    button('翻译设置',()=>send({type:'OPEN_OPTIONS'}),tools);
    output.setAttribute('role','status');output.setAttribute('aria-live','polite');
    card.append(meta,output,tools);root.append(style,card);
    card.addEventListener('pointerdown',event=>{if(event.target.closest('button'))event.preventDefault();});
    card.addEventListener('click',event=>{event.stopPropagation();event.preventDefault();});
    Object.assign(record,{host,output,status,copy,retry});
  }
  async function runSelection(record) {
    if(record.state==='running')return;
    record.state='running';record.stale=false;record.result='';const epoch=++record.epoch;
    if(record.copy){record.copy.disabled=true;record.retry.hidden=true;record.output.className='text';}
    record.output.textContent='正在结合上下文翻译…';
    let result;
    for(let attempt=0;attempt<4;attempt++) {
      result=await send({type:'TRANSLATE',text:record.text,context:record.context,runId:record.id,priority:true});
      if(epoch!==record.epoch)return;
      if(result.code!=='RATE_LIMIT' || attempt===3)break;
      const until=result.retryAt||Date.now()+30000;
      while(Date.now()<until && epoch===record.epoch) {
        record.output.textContent=`服务限流 · ${Math.ceil((until-Date.now())/1000)} 秒后自动重试（${attempt+1}/3）`;
        await new Promise(resolve=>{const timer=setTimeout(resolve,Math.max(1,Math.min(1000,until-Date.now())));record.cancelWait=()=>{clearTimeout(timer);resolve();};});
      }
      record.cancelWait=null;
      if(epoch!==record.epoch)return;
    }
    if(epoch!==record.epoch)return;
    if(record.anchor && (!record.anchor.isConnected || sourceText(record.anchor)!==record.anchorText)){closeSelection(record);return;}
    record.state=result.ok?'done':'error';record.result=result.ok?result.text:'';
    record.output.textContent=result.ok?result.text:result.error;
    const label=result.ok?'墨序 · '+(result.cached?'本次会话缓存':'所选文字译文'):'墨序 · 翻译失败';
    if(record.status){record.status.textContent=label;record.copy.disabled=!result.ok;record.retry.hidden=result.ok;record.output.className=result.ok?'text':'text error';}
    else {
      if(!enabled)panelCount.textContent=label;
      if(!result.ok)button('重试翻译',()=>runSelection(record),record.output);
      else button('复制译文',event=>copyTranslation(record,event.currentTarget),record.output);
    }
  }
  function selection(explicit,snapshot) {
    hideToolbar();
    const selected=getSelection();
    if(document.activeElement?.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role=textbox]')){ensurePanel();panelBody.textContent='不读取输入框或编辑区中的选区。';return;}
    snapshot=snapshot || captureSelection() || (!selected?.toString().trim()?savedSelection:null);
    if(selected?.toString().trim() && !snapshot){ensurePanel();panelBody.textContent='不读取输入框、代码区、隐藏内容或墨序面板中的选区。';return;}
    const text=String(explicit || snapshot?.text || '').trim();
    if(!text || text.length>16000){ensurePanel();panelBody.textContent=text?'所选文本超过 16000 字符，请缩小选择范围。':'请先在网页中选中文字，点击选区旁的“翻译所选文字”，或按 Alt + Shift + S。';return;}
    // The context menu may supply text after the browser has discarded its Range.
    if(snapshot && (!snapshot.anchor.isConnected || sourceText(snapshot.anchor)!==snapshot.anchorText || (explicit && !snapshot.text.replace(/\s+/g,' ').includes(text.replace(/\s+/g,' ')))))snapshot=null;
    for(const record of selections.values()) {
      if(snapshot && !record.stale && record.text===text && record.anchor===snapshot.anchor){
        if(record.state==='error')runSelection(record);
        record.host?.scrollIntoView({block:'nearest'});return;
      }
    }
    // Keep at most one unfinished selection request; completed cards remain for comparison.
    for(const record of selections.values())if(record.state==='running' || !record.host)closeSelection(record);
    while(selections.size>=40)closeSelection(selections.values().next().value);
    const record={id:newId(),epoch:0,text,anchor:snapshot?.anchor,sources:snapshot?.sources,anchorText:snapshot?.anchorText,context:snapshot?.context || {title:document.title}};
    selections.set(record.id,record);
    if(snapshot) {
      selectionCard(record);
      selectionObserver.observe(document.body,{childList:true,subtree:true,characterData:true});
      record.host.scrollIntoView({block:'nearest'});
    } else {ensurePanel();record.output=panelBody;}
    runSelection(record);
  }
  const selectionObserver=new MutationObserver(mutations=>{
    if(mutations.every(m=>m.target.closest?.('[data-qingyi]')))return;
    for(const record of selections.values())if(record.sources?.some(source=>!source.el.isConnected || sourceText(source.el)!==source.text))closeSelection(record);
  });
  function waitForRate(until) {
    cooldownUntil=Math.max(cooldownUntil,until||Date.now()+30000);
    clearTimeout(cooldownTimer);ensurePanel();
    const tick=()=> {
      if(!enabled)return;
      const seconds=Math.ceil((cooldownUntil-Date.now())/1000);
      if(seconds>0) {
        panelBody.textContent=`服务限流 · ${seconds} 秒后自动继续。恢复原文可停止等待。`;
        cooldownTimer=setTimeout(tick,Math.min(1000,cooldownUntil-Date.now()));
      } else {cooldownUntil=0;panelBody.textContent='已恢复，按顺序翻译可见段落。';pump();}
    };tick();
  }
  function ensureBall() {
    if(dormant)return;
    if(ball?.isConnected)return;
    ball=document.createElement('div');ball.setAttribute('data-qingyi','launcher');
    for(const [k,v] of Object.entries({all:'initial',position:'fixed',right:'12px',top:'45vh','z-index':'2147483647',display:'block'}))ball.style.setProperty(k,v,'important');
    const root=ball.attachShadow({mode:'open'}),style=document.createElement('style');
    style.textContent='button{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;border:1px solid #d6c5aa;background:#292827;color:#fff;font:600 20px Optima,"Hiragino Sans GB","PingFang SC",system-ui,sans-serif;box-shadow:0 4px 18px #29282740;cursor:pointer;touch-action:none}button:hover{background:#45413b}button:focus-visible{outline:3px solid #d6c5aa;outline-offset:3px}';root.append(style);
    let moved=false,startY=0,startTop=0;
    const b=button('译',()=>{if(moved)return;const existing=panel?.isConnected;ensurePanel();if(!enabled&&!existing){panelCount.textContent='墨序 · 随时开始';panelBody.textContent='点击“翻译网页”开启双语阅读，也可以先选中文字再翻译。';}else progress();},root);
    b.setAttribute('aria-label','墨序悬浮球 · 打开翻译面板');b.title='墨序 · 点击打开，拖动调整高度';
    b.addEventListener('pointerdown',e=>{moved=false;startY=e.clientY;startTop=ball.getBoundingClientRect().top;b.setPointerCapture(e.pointerId);});
    b.addEventListener('pointermove',e=>{if(!b.hasPointerCapture(e.pointerId))return;if(Math.abs(e.clientY-startY)>4)moved=true;if(moved)ball.style.setProperty('top',Math.max(8,Math.min(innerHeight-54,startTop+e.clientY-startY))+'px','important');});
    document.documentElement.append(ball);
  }
  ensureBall();
  send({type:'GET_PREFERENCES'}).then(result=>{if(result.ok){selectionToolbar=result.selectionToolbar;pageConcurrency=result.concurrency||1;pump();}});
  document.addEventListener('selectionchange',()=>{clearTimeout(selectionTimer);selectionTimer=setTimeout(updateSelection,120);});
  document.addEventListener('pointerup',event=>{if(event.composedPath().some(node=>node.hasAttribute?.('data-qingyi')))return;clearTimeout(selectionTimer);selectionTimer=setTimeout(updateSelection,20);});
  document.addEventListener('pointerdown',event=>{if(!event.composedPath().some(node=>node.hasAttribute?.('data-qingyi')))hideToolbar();});
  document.addEventListener('scroll',positionToolbar,{passive:true,capture:true});
  window.addEventListener('resize',positionToolbar,{passive:true});
  document.addEventListener('keydown',event=> {
    if(!event.isTrusted)return;
    if(event.key==='Escape'){clearTimeout(selectionTimer);hideToolbar();return;}
    if(!dormant && event.altKey && event.shiftKey && event.code==='KeyS') {event.preventDefault();selection();}
  });
  chrome.runtime.onMessage.addListener((message,sender,respond)=> {
    if(sender.id!==chrome.runtime.id)return;
    if(message.type==='TRANSLATE_PROGRESS'){
      const record=selections.get(message.runId) || [...records.values()].find(r=>r.id===message.runId);
      const el=record?.anchor || record?.el;
      if(record?.state==='running' && !record.stale && (!el || el.isConnected)){
        record.output.textContent=message.text || (message.phase==='waiting'?'正在等待翻译…':'模型正在生成译文…');
        if(record.status)record.status.textContent=message.text?'墨序 · 正在生成':'墨序 · 等待译文';
      }
      respond({ok:true});return;
    }
    if(message.type!=='PAGE_ACTION')return;
    if(['start','toggle','selection','launcher'].includes(message.action)){dormant=false;ensureBall();}
    switch(message.action) {
      case 'toggle': enabled?restore():start();break;
      case 'start': start();break;
      case 'restore': restore();break;
      case 'retry': retryFailed();break;
      case 'selection': selection(message.text);break;
      case 'status': break;
      case 'launcher': ensureBall();break;
      case 'hide-launcher': dormant=true;restore(false);ball?.remove();break;
      case 'settings-changed':
        selectionToolbar=message.selectionToolbar!==false;if(!selectionToolbar)hideToolbar();
        pageConcurrency=message.concurrency||1;
        for(const record of selections.values())record.stale=true;
        pump();
        break;
    }
    respond({enabled,paused,count:records.size,selections:selections.size});
  });
})();
