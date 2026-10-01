(() => {
  if (globalThis.__qingyi) return;
  globalThis.__qingyi = true;
  const selector = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,div,section';
  const blockSelector = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,div,section,ul,ol,table';
  const excluded = 'script,style,noscript,pre,code,textarea,input,select,button,a,nav,aside,header,footer,form,[role=button],[role=navigation],[role=banner],[role=contentinfo],[role=toolbar],[role=menu],[role=dialog],svg,math,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[aria-hidden="true"],[hidden],[data-qingyi]';
  let enabled = false, runId = '', generation = 0, observer, intersection, scanTimer, panel, panelBody, panelCount;
  let running = 0, maxReached = false;
  const records = new Map(), pending = [];
  const fatalCodes = new Set(['CONFIG','PERMISSION','HTTP_400','HTTP_401','HTTP_402','HTTP_403','HTTP_404','QUOTA_EXHAUSTED']);
  let fatal = false, cooldownUntil=0, cooldownTimer, ball;
  const send = async message => {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return {ok: false, error: '扩展连接中断，请刷新网页后重试。', code: 'DISCONNECTED'}; }
  };
  const sourceText = el => (el.innerText || el.textContent || '').trim();
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
    const b = document.createElement('button'); b.textContent = text; b.type = 'button'; b.addEventListener('click', fn); container.append(b); return b;
  }
  function ensurePanel() {
    if (panel?.isConnected) {panel.shadowRoot.querySelector('.card').hidden=false;panel.shadowRoot.querySelector('.compact').hidden=true;return;}
    panel = document.createElement('div'); panel.setAttribute('data-qingyi', 'panel');
    panel.style.cssText = 'all:initial;position:fixed;right:22px;bottom:22px;z-index:2147483647;display:block;max-width:calc(100vw - 32px);';
    const root = panel.attachShadow({mode:'open'});
    const style = document.createElement('style'); style.textContent = `
      :host{color-scheme:light}*{box-sizing:border-box}.card{width:340px;max-width:calc(100vw - 32px);background:#fbfaf7;color:#263b38;font:14px/1.6 system-ui,sans-serif;border:1px solid #d4dfd9;border-radius:16px;box-shadow:0 12px 48px #18342c30;padding:16px}.head{display:flex;justify-content:space-between;align-items:center;font-weight:650;font-size:16px}.count{font:12px/1.6 system-ui;color:#687a73;margin:8px 0}.body{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}button{font:12px system-ui;border:1px solid #cdd9d2;border-radius:7px;padding:6px 10px;background:white;color:#204e41;cursor:pointer}button:hover{background:#edf4ef}button:focus-visible{outline:2px solid #357962} .head button{border:0;background:transparent;padding:0 4px;font-size:18px}.compact button{background:#fbfaf7;border:1px solid #cdd9d2;box-shadow:0 4px 18px #18342c20;padding:9px 14px;font-size:13px}[hidden]{display:none!important}`;
    const card = document.createElement('section'); card.className = 'card'; card.setAttribute('aria-label','清译翻译面板');
    const head = document.createElement('div'); head.className = 'head'; const title = document.createElement('span'); title.textContent='清译'; head.append(title);
    button('−', () => {card.hidden=true;compact.hidden=true;}, head).setAttribute('aria-label','收起面板');
    const compact=document.createElement('div'); compact.className='compact';compact.hidden=true;
    button('清译 · 展开',()=>{card.hidden=false;compact.hidden=true;},compact);
    root.append(compact);
    panelCount = document.createElement('div'); panelCount.className = 'count'; panelCount.setAttribute('aria-live','polite');
    panelBody = document.createElement('div'); panelBody.className = 'body';
    const actions = document.createElement('div'); actions.className = 'actions';
    button('翻译网页', start, actions); button('翻译所选文字',()=>selection(),actions); button('重试失败', retryFailed, actions); button('恢复原文', restore, actions);
    card.append(head,panelCount,panelBody,actions); root.append(style,card); document.documentElement.append(panel);
  }
  function progress() {
    if (!panelCount || !enabled) return;
    const all=[...records.values()];
    panelCount.textContent = `${all.filter(r=>r.state==='done').length} 段已译 · ${all.filter(r=>r.state==='running'||r.state==='queued').length} 段进行中 · ${all.filter(r=>r.state==='error').length} 段失败 · ${all.filter(r=>r.state==='waiting').length} 段待阅读${all.some(r=>r.state==='unchanged')?' · '+all.filter(r=>r.state==='unchanged').length+' 段无需变更':''}${maxReached?' · 已达本页 400 段上限':''}`;
  }
  function makeTranslation(el) {
    const host = document.createElement('span'); host.setAttribute('data-qingyi', 'translation');
    const sourceStyle=getComputedStyle(el);
    // Sibling insertion must inherit the paragraph's typography, not a white/transparent parent.
    const color=sourceStyle.color==='rgba(0, 0, 0, 0)'?'CanvasText':sourceStyle.color;
    const fontSize=Math.min(24,Math.max(14,parseFloat(sourceStyle.fontSize)||16))+'px';
    const properties={all:'initial',display:'block',margin:'8px 0 14px',color,'font-size':fontSize,'font-family':'system-ui, -apple-system, BlinkMacSystemFont, sans-serif','font-weight':'400','line-height':'1.8','text-align':sourceStyle.textAlign,'-webkit-text-fill-color':color,visibility:'visible',opacity:'1','max-width':'100%'};
    for(const [key,value] of Object.entries(properties))host.style.setProperty(key,value,'important');
    const root = host.attachShadow({mode:'open'});
    const style = document.createElement('style'); style.textContent = ':host{color-scheme:light dark}.text{border-left:2px solid #58a187;padding:5px 0 5px 12px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.8;color:inherit;-webkit-text-fill-color:currentColor;opacity:1}.error{color:#b15742;font-size:13px}button{background:transparent;color:inherit;border:1px solid currentColor;border-radius:5px;margin-left:8px;padding:2px 7px;cursor:pointer}';
    const output = document.createElement('div'); output.className='text'; output.textContent='正在翻译…';
    root.append(style,output); if (['TD','TH','LI'].includes(el.tagName)) el.append(host); else el.after(host); return {host,output};
  }
  function enqueue(record) {
    if (!enabled || fatal || record.state !== 'waiting' || !record.el.isConnected) return;
    record.state='queued'; intersection?.unobserve(record.el); pending.push(record); pump();
  }
  function pump() {
    while (enabled && !fatal && Date.now()>=cooldownUntil && running < 1 && pending.length) {
      const record = pending.shift(); if (!record.el.isConnected || !records.has(record.el)) continue;
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
      const result = await send({type:'TRANSLATE', text:record.text, context:contextFor(record.el), runId});
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
        button('重试',()=> { fatal=false; record.state='waiting'; enqueue(record); },record.output);
        if (fatalCodes.has(result.code) || result.code==='RATE_LIMIT') { fatal=true; ensurePanel(); panelBody.textContent=result.error+(result.code==='RATE_LIMIT'?'\n连续限流已暂停。稍后点击“重试失败”。':'\n处理后点击“重试失败”。'); }
      }
    } finally { if (current === generation) { running--; pump(); } }
  }
  function scan() {
    if (!enabled) return;
    for (const [el, r] of records) {
      if (!el.isConnected || sourceText(el)!==r.text) { intersection?.unobserve(el); r.host?.remove(); records.delete(el); const i=pending.indexOf(r); if(i>=0)pending.splice(i,1); }
    }
    for (const el of document.querySelectorAll(selector)) {
      if (records.size >= 400) { maxReached=true; break; }
      if (records.has(el) || !eligible(el)) continue;
      const record={el,text:sourceText(el),state:'waiting'}; records.set(el,record); intersection.observe(el);
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
    panelBody.textContent='Chrome 已经改写了网页原文。请点击地址栏旁的翻译按钮，切回原语言，再使用清译。';
  }
  function start() {
    if(nativeTranslationActive()){nativeConflict();return;}
    if (enabled) {ensurePanel();progress();return;}
    enabled=true; fatal=false; maxReached=false; runId=crypto.randomUUID(); generation++; running=0;
    ensurePanel(); panelBody.textContent='随阅读翻译段落。API 服务可能按用量计费。';
    intersection=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){const r=records.get(e.target);if(r)enqueue(r);}}),{rootMargin:'0px'});
    observer=new MutationObserver(mutations=> {
      if(nativeTranslationActive()){nativeConflict();return;}
      if (mutations.some(m=>!m.target.closest?.('[data-qingyi]') && !(m.type==='childList' && [...m.addedNodes,...m.removedNodes].every(n=>n.nodeType===1 && n.hasAttribute('data-qingyi'))))) scheduleScan();
    });
    observer.observe(document.body,{childList:true,subtree:true,characterData:true}); observer.observe(document.documentElement,{attributes:true,attributeFilter:['class']}); scan();
  }
  function restore() {
    const old=runId; selectionEpoch++; if(selectionId) send({type:'CANCEL',runId:selectionId}); selectionId=''; enabled=false; generation++; running=0; runId='';
    observer?.disconnect(); intersection?.disconnect(); clearTimeout(scanTimer); clearTimeout(cooldownTimer);cooldownUntil=0; pending.length=0;
    for (const r of records.values()) r.host?.remove(); records.clear(); panel?.remove();
    send({type:'CANCEL',runId:old}); ensureBall();
  }
  let selectionId='', selectionEpoch=0;
  async function selection(explicit) {
    selectionEpoch++;
    if(selectionId) send({type:'CANCEL',runId:selectionId});
    selectionId='';
    const selected=window.getSelection();
    const el=selected?.anchorNode?.nodeType===1? selected.anchorNode:selected?.anchorNode?.parentElement;
    if (el?.closest('script,style,noscript,pre,code,textarea,input,select,button,[contenteditable]:not([contenteditable="false"]),[role=textbox],[aria-hidden="true"],[hidden],[data-qingyi]')) {ensurePanel();panelBody.textContent='不读取输入框、代码区或清译面板中的选区。';return;}
    const text=String(explicit || selected?.toString() || '').trim();
    ensurePanel();
    if (!text) {panelBody.textContent='请先在网页中选中文字，再右键选择“用清译翻译所选文字”。';return;}
    if(selectionId) send({type:'CANCEL',runId:selectionId});
    selectionId=crypto.randomUUID(); const epoch=++selectionEpoch;
    panelBody.textContent='正在结合上下文翻译…';
    const parent=el?.closest('p,li,td,blockquote,article') || el;
    const context={...contextFor(parent),before:safeNeighbor(parent)};
    let result;
    for(let attempt=0;attempt<4;attempt++) {
      result=await send({type:'TRANSLATE',text,context,runId:selectionId});
      if(epoch!==selectionEpoch)return;
      if(result.code!=='RATE_LIMIT'||attempt===3)break;
      const until=result.retryAt||Date.now()+30000;
      while(Date.now()<until && epoch===selectionEpoch) {
        panelBody.textContent=`服务限流 · ${Math.ceil((until-Date.now())/1000)} 秒后自动重试（${attempt+1}/3）`;
        await new Promise(resolve=>setTimeout(resolve,Math.min(1000,until-Date.now())));
      }
      if(epoch!==selectionEpoch)return;
    }
    if(epoch!==selectionEpoch) return;
    panelBody.textContent=result.ok?result.text:result.error;
    if(!enabled)panelCount.textContent=result.ok?'划词翻译 · '+(result.cached?'本次会话缓存':'AI 上下文翻译'):'翻译失败';
  }
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
    if(ball?.isConnected)return;
    ball=document.createElement('div');ball.setAttribute('data-qingyi','launcher');
    for(const [k,v] of Object.entries({all:'initial',position:'fixed',right:'12px',top:'45vh','z-index':'2147483647',display:'block'}))ball.style.setProperty(k,v,'important');
    const root=ball.attachShadow({mode:'open'}),style=document.createElement('style');
    style.textContent='button{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;border:1px solid #bdd5c9;background:#235c4d;color:#fff;font:600 20px system-ui;box-shadow:0 4px 18px #14382f40;cursor:pointer;touch-action:none}button:hover{background:#32735f}button:focus-visible{outline:3px solid #a5cbb9;outline-offset:3px}';root.append(style);
    let moved=false,startY=0,startTop=0;
    const b=button('译',()=>{if(moved)return;const existing=panel?.isConnected;ensurePanel();if(!enabled&&!existing){panelCount.textContent='清译 · 随时开始';panelBody.textContent='点击“翻译网页”开启双语阅读，也可以先选中文字再翻译。';}else progress();},root);
    b.setAttribute('aria-label','清译悬浮球 · 打开翻译面板');b.title='清译 · 点击打开，拖动调整高度';
    b.addEventListener('pointerdown',e=>{moved=false;startY=e.clientY;startTop=ball.getBoundingClientRect().top;b.setPointerCapture(e.pointerId);});
    b.addEventListener('pointermove',e=>{if(!b.hasPointerCapture(e.pointerId))return;if(Math.abs(e.clientY-startY)>4)moved=true;if(moved)ball.style.setProperty('top',Math.max(8,Math.min(innerHeight-54,startTop+e.clientY-startY))+'px','important');});
    document.documentElement.append(ball);
  }
  ensureBall();
  document.addEventListener('keydown',event=> {
    if(event.altKey && event.shiftKey && event.code==='KeyS') {event.preventDefault();selection();}
  });
  chrome.runtime.onMessage.addListener((message,sender,respond)=> {
    if(sender.id!==chrome.runtime.id || message.type!=='PAGE_ACTION')return;
    switch(message.action) {
      case 'toggle': enabled?restore():start();break;
      case 'start': start();break;
      case 'restore': restore();break;
      case 'retry': retryFailed();break;
      case 'selection': selection(message.text);break;
      case 'status': break;
      case 'launcher': ensureBall();break;
    }
    respond({enabled,count:records.size});
  });
})();
