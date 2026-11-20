import {test,expect,chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

let context,worker,id,server,origin,options,page,requests=[],behavior='ok',active=0,maxActive=0;
const html=`<!doctype html><html lang="en"><head><title>Research notes · a reading test</title><style>body{margin:60px auto;max-width:780px;font:18px/1.8 system-ui;color:#293d37;background:#fdfdfb}h1{font-size:42px;line-height:1.2}p{margin:24px 0}nav{padding:10px;background:#eee}article{padding:20px}code{background:#eee}input{padding:10px}</style></head><body><nav>Navigation must remain untranslated</nav><article><h1>Read science, with context.</h1><p id="first">The treatment did not significantly reduce the risk. The confidence interval includes zero.</p><p id="second">A <a href="#reference">qubit</a> can be in a superposition of states. This does not imply that it stores two classical bits.</p><p id="code"><code>const secret = "do not translate";</code></p><input type="password" value="private-password"><div contenteditable="true">Private draft must not be sent</div><p hidden>Hidden secret must not be sent</p><ul><li>List items should retain their original structure.</li></ul><table><tbody><tr><td>Table cells contain readable text.</td></tr></tbody></table><div id="dynamic"></div></article></body></html>`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function command(action,text){return worker.evaluate(async({tabUrl,action,text})=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url===tabUrl);await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});return chrome.tabs.sendMessage(tab.id,{type:'PAGE_ACTION',action,text});},{tabUrl:origin+'/article',action,text});}
async function configure(apiKey='test-only'){
 await worker.evaluate(async({origin,apiKey})=>{await chrome.storage.local.set({settings:{endpoint:origin+'/v1',apiKey,model:'test-model',target:'简体中文',domain:'学术论文',glossary:'qubit = 量子比特',concurrency:1,requestInterval:50,timeout:120,performanceVersion:1}});},{origin,apiKey});
}
test.beforeAll(async()=>{
 server=createServer(async(req,res)=>{
  if(req.url==='/article'){res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(html);return;}
  if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'qwen-chat'},{id:'deepseek-flash'},{id:'qwen3-embedding'}]}));return;}
  if(req.url==='/v1/chat/completions'){
   let raw='';for await(const chunk of req)raw+=chunk;
   const body=JSON.parse(raw);requests.push({body,auth:req.headers.authorization,at:Date.now()});active++;maxActive=Math.max(maxActive,active);
   const currentBehavior=behavior;
   if(currentBehavior==='slow')await sleep(700);else if(currentBehavior==='benchmark')await sleep(1500);else await sleep(50);
   active--;
   if(currentBehavior==='quota'){res.writeHead(429);res.end(JSON.stringify({error:{code:'insufficient_quota'}}));return;}
   if(currentBehavior==='429-always'){res.writeHead(429,{'Retry-After':'2'});res.end('{}');return;}
   if(currentBehavior==='401'){res.writeHead(401);res.end('{}');return;}
   if(currentBehavior==='429-once'){behavior='ok';res.writeHead(429,{'Retry-After':'1'});res.end('{}');return;}
   if(currentBehavior==='stream-unsupported' && body.stream){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'stream is not supported'}}));return;}
   const source=JSON.parse(body.messages[1].content).source_text;
   const translated=source==='无需重复翻译的中文标题'?source:source.includes('treatment')?'该治疗未显著降低风险。置信区间包含零。':source.includes('qubit')?'量子比特可以处于状态的叠加。这不意味着它存储两个经典比特。':source.includes('HTML')?'<img src=x onerror="window.pwned=true">':'示例译文：'+source;
   if(['stream','stream-long','stream-interrupted'].includes(currentBehavior)){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const delta=text=>'data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n';
    res.write(delta(translated.slice(0,3)));await sleep(currentBehavior==='stream-long'?32000:650);
    if(res.destroyed)return;
    if(currentBehavior==='stream-interrupted'){res.end();return;}
    res.end(delta(translated.slice(3))+'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');return;
   }
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:translated},finish_reason:'stop'}]}));return;
  }
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 const extension=path.resolve('work/test-extension');await cp('src',extension,{recursive:true});
 // Use an explicitly configured mock pace; shipping defaults remain unchanged.
 await writeFile(extension+'/background.js',(await readFile(extension+'/background.js','utf8'))+'\nglobalThis.testGate=gateReady;globalThis.testFinishFloating=finishPendingFloat;');
 const manifest=JSON.parse(await readFile(extension+'/manifest.json','utf8'));
 // Test fixture grants only the loopback mock origin. Shipped manifest is unchanged.
 manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(extension+'/manifest.json',JSON.stringify(manifest));
 context=await chromium.launchPersistentContext(await mkdtemp(path.resolve('work/browser-test-')),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');id=worker.url().split('/')[2];
 await configure();options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);
 page=await context.newPage();await page.goto(origin+'/article');
});
test.afterAll(async()=>{await context?.close();await new Promise(r=>server?.close(r));});
test.beforeEach(async()=>{await command('restore');await page.goto(origin+'/article');await sleep(100);behavior='ok';requests=[];maxActive=0;await configure();await worker.evaluate(async()=>{const gate=await globalThis.testGate;gate.state={nextAt:0,cooldownUntil:0,strikes:0};});await options.evaluate(()=>chrome.runtime.sendMessage({type:'CLEAR_CACHE'}));await page.goto(origin+'/article');});

test('actual MV3 worker + bilingual paragraphs, context, safe inputs and DOM restoration',async()=>{
 const original=await page.locator('article').innerHTML();await command('start');
 await expect(page.locator('[data-qingyi="translation"]')).toHaveCount(5);
 await expect(page.locator('#first + [data-qingyi]')).toContainText('未显著降低');
 await expect(page.locator('#second + [data-qingyi]')).toContainText('量子比特');
 await expect(page.locator('li [data-qingyi]')).toContainText('示例译文');
 await expect(page.locator('td [data-qingyi]')).toContainText('示例译文');
 const sources=requests.map(r=>JSON.parse(r.body.messages[1].content).source_text).join('\n');
 expect(sources).not.toMatch(/private-password|Private draft|Hidden secret|Navigation|const secret/);
 expect(requests.every(r=>r.auth==='Bearer test-only')).toBe(true);expect(maxActive).toBeLessThanOrEqual(2);
 expect(requests.some(r=>JSON.parse(r.body.messages[1].content).context.title.includes('Research'))).toBe(true);
 await command('restore');await expect(page.locator('[data-qingyi="translation"]')).toHaveCount(0);expect(await page.locator('article').innerHTML()).toBe(original);
});
test('dynamic content and changed paragraphs receive fresh translations without duplicate nodes',async()=>{
 await command('start');await expect(page.locator('#first + [data-qingyi]')).toContainText('未显著降低');
 await page.evaluate(()=>{document.querySelector('#dynamic').innerHTML='<p id="added">Dynamically loaded scientific paragraph.</p>';document.querySelector('#first').textContent='Updated research result.';});
 await page.locator('#added').scrollIntoViewIfNeeded();
 await expect(page.locator('#added + [data-qingyi]')).toContainText('Dynamically loaded');
 await page.locator('#first').scrollIntoViewIfNeeded();
 await expect(page.locator('#first + [data-qingyi]')).toContainText('Updated research result');
 expect(await page.locator('#first + [data-qingyi] + [data-qingyi]').count()).toBe(0);
});
test('selection includes sentence context and renders HTML-like responses only as text',async()=>{
 await page.locator('#second').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);});
 await command('selection','qubit');await expect(page.locator('#second + [data-qingyi="selection"] .text')).toContainText('量子比特');
 const last=JSON.parse(requests.at(-1).body.messages[1].content);expect(last.source_text).toBe('qubit');expect(last.context.before).toContain('superposition');
 await command('selection','HTML');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('<img');
 expect(await page.locator('[data-qingyi="panel"] img').count()).toBe(0);expect(await page.evaluate(()=>window.pwned)).toBeUndefined();
});
test('401 pauses queue, shows actionable error, and supports retry after correcting credentials',async()=>{
 behavior='401';await command('start');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('密钥无效');await sleep(250);
 expect(requests.length).toBeLessThanOrEqual(2);
 behavior='ok';await configure('corrected-test-key');await command('retry');await expect(page.locator('#first + [data-qingyi]')).toContainText('未显著降低');
});
test('transient rate limit retries automatically',async()=>{
 behavior='429-once';await command('selection','A new rate-limited sentence.');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('示例译文');expect(requests.length).toBe(2);
});
test('restore while requests are running prevents late insertion',async()=>{
 behavior='slow';await command('start');await expect(page.locator('[data-qingyi="translation"]')).toHaveCount(1);await command('restore');await sleep(900);
 expect(await page.locator('[data-qingyi="translation"]').count()).toBe(0);expect(await page.locator('[data-qingyi="panel"]').count()).toBe(0);
});
test('options page loads, hides secret, blocks unsaved test and tests saved connection',async()=>{
 await options.reload();await expect(options.locator('#apiKey')).toHaveAttribute('type','password');await options.locator('#model').fill('different-model');await options.locator('#test').click();await expect(options.locator('#status')).toContainText('请先保存');
 await options.reload();await options.locator('#test').click();await expect(options.locator('#status')).toContainText('连接成功');
 await options.screenshot({path:'work/settings-preview.png',fullPage:true});
});
test('cached result avoids duplicate request until settings change',async()=>{
 await command('selection','A cacheable phrase.');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('示例译文');expect(requests.length).toBe(1);
 await command('selection','A cacheable phrase.');await sleep(150);expect(requests.length).toBe(1);
 await configure('changed-key');await command('selection','A cacheable phrase.');await sleep(200);expect(requests.length).toBe(2);
});
test('page screenshot for visual review',async()=>{
 await command('start');await expect(page.locator('#second + [data-qingyi]')).toContainText('量子比特');
 await page.screenshot({path:'work/bilingual-preview.png',fullPage:true});
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await popup.setViewportSize({width:344,height:530});await popup.screenshot({path:'work/popup-preview.png'});await popup.close();
});
test('saved settings round-trip through the real extension UI',async()=>{
 await options.reload();await options.locator('#model').fill('saved-model');await options.locator('#save').click();await expect(options.locator('#status')).toContainText('设置已保存');await options.reload();await expect(options.locator('#model')).toHaveValue('saved-model');
});
test('content script cannot read API credentials and restricted pages get useful errors',async()=>{
 await command('status');
 const contentResult=await worker.evaluate(async url=>{
  const tab=(await chrome.tabs.query({})).find(t=>t.url===url);
  const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{try{const v=await chrome.storage.local.get('settings');return {leaked:!!v.settings?.apiKey};}catch{return {blocked:true};}}});return r.result;
 },origin+'/article');
 expect(contentResult).toEqual({blocked:true});
 const restricted=await context.newPage();await restricted.goto('chrome://version/');
 const tabId=await worker.evaluate(async()=>{const tab=await chrome.tabs.create({url:'chrome://version/',active:false});return tab.id;});
 const result=await options.evaluate(tabId=>chrome.runtime.sendMessage({type:'PAGE',tabId,action:'start'}),tabId);expect(result.ok).toBe(false);expect(result.code).toBe('PAGE_RESTRICTED');await restricted.close();
});
test('model discovery and USTC preset use correct endpoint and clear other provider credentials',async()=>{
 await options.reload();await options.locator('#models').click();await expect(options.locator('#status')).toContainText('模型列表已更新');await expect(options.locator('#modelsHelp')).toContainText('2 个文本模型');await expect(options.locator('#modelList option')).toHaveCount(2);
 await options.locator('#preset').selectOption('ustc');await expect(options.locator('#endpoint')).toHaveValue('https://api.llm.ustc.edu.cn/v1');await expect(options.locator('#model')).toHaveValue('qwen-chat');await expect(options.locator('#apiKey')).toHaveValue('');
});
test('translation inherits paragraph color and isolates hostile global span styles',async()=>{
 await page.addStyleTag({content:'article{color:white}article p,article h1,li,td{color:rgb(20,30,40)}span{color:transparent!important;font-size:0!important;-webkit-text-fill-color:transparent!important}'});
 await command('start');await expect(page.locator('#first + [data-qingyi]')).toContainText('未显著降低');
 const style=await page.locator('#first + [data-qingyi]').evaluate(host=>{const c=getComputedStyle(host.shadowRoot.querySelector('.text'));return {color:c.color,fill:c.webkitTextFillColor,size:parseFloat(c.fontSize)};});
 expect(style.color).toBe('rgb(20, 30, 40)');expect(style.fill).toBe('rgb(20, 30, 40)');expect(style.size).toBeGreaterThanOrEqual(14);
});
test('navigation links and form-like controls remain untouched',async()=>{
 await page.evaluate(()=>{const nav=document.createElement('div');nav.innerHTML='<a href="#"><div id="navlabel">Contact us</div></a><div id="actions"><button>Reset changes</button><button>Report problems with this page</button></div>';document.body.prepend(nav);});
 await command('start');await expect(page.locator('#first + [data-qingyi]')).toContainText('未显著降低');
 expect(await page.locator('#navlabel [data-qingyi],#navlabel + [data-qingyi],#actions + [data-qingyi]').count()).toBe(0);
});
test('collapsed panel stays available and reopening preserves selection translation',async()=>{
 await command('selection','A collapsible phrase.');const body=page.locator('[data-qingyi="panel"] .body');await expect(body).toContainText('示例译文');
 await page.getByRole('button',{name:'收起面板'}).click();await expect(body).toBeHidden();
 await page.getByRole('button',{name:'墨序悬浮球 · 打开翻译面板'}).click();await expect(body).toContainText('A collapsible phrase.');
});
test('retry resumes paragraphs added while authentication error paused the queue',async()=>{
 behavior='401';await command('start');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('密钥无效');
 await page.evaluate(()=>{const p=document.createElement('p');p.id='paused-new';p.textContent='A new paragraph loaded while translation was paused.';document.querySelector('article').prepend(p);});
 await sleep(500);behavior='ok';await configure('new-test-key');await command('retry');await expect(page.locator('#paused-new + [data-qingyi]')).toContainText('示例译文');
});
test('a selected word inside a hyperlink can still be translated',async()=>{
 await page.locator('#second a').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);});
 await command('selection');await expect(page.locator('#second + [data-qingyi="selection"] .text')).toContainText('量子比特');
});
test('native Chrome translation blocks new work and cancels active translation',async()=>{
 await page.evaluate(()=>document.documentElement.classList.add('translated-ltr'));await command('start');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('切回原语言');expect(requests.length).toBe(0);
 await page.evaluate(()=>document.documentElement.classList.remove('translated-ltr'));await command('start');await expect(page.locator('#first + [data-qingyi]')).toContainText('未显著降低');
 await page.evaluate(()=>document.documentElement.classList.add('translated-ltr'));await expect(page.locator('[data-qingyi="translation"]')).toHaveCount(0);await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('切回原语言');
});
test('identical translated text does not create duplicate Chinese headings',async()=>{
 await page.locator('h1').evaluate(el=>el.textContent='无需重复翻译的中文标题');await command('start');await expect(page.locator('#first + [data-qingyi]')).toContainText('未显著降低');await expect(page.locator('h1 + [data-qingyi]')).toHaveCount(0);
});

test('floating ball opens actions before translating and remains after restoring',async()=>{
 await command('launcher');const ball=page.getByRole('button',{name:'墨序悬浮球 · 打开翻译面板'});
 await expect(ball).toBeVisible();expect(requests.length).toBe(0);
 await ball.click();await page.getByRole('button',{name:'翻译网页',exact:true}).click();
 await expect(page.locator('#first + [data-qingyi]')).toContainText('未显著降低');
 await page.getByRole('button',{name:'恢复原文',exact:true}).click();await expect(ball).toBeVisible();
 await expect(page.locator('[data-qingyi="translation"]')).toHaveCount(0);
});
test('quota exhaustion stops page retries and displays account action',async()=>{
 behavior='quota';await command('start');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('额度不足');
 await sleep(1200);expect(requests.length).toBe(1);
});
test('rate cooldown is global across tabs and restore cancels scheduled retry',async()=>{
 behavior='429-always';await command('start');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('秒后自动继续');
 const result=await options.evaluate(()=>chrome.runtime.sendMessage({type:'TRANSLATE',text:'Other tab request',runId:'other'}));
 expect(result.code).toBe('RATE_LIMIT');expect(result.retryAt).toBeGreaterThan(Date.now());expect(requests.length).toBe(1);
 await command('restore');await sleep(2300);expect(requests.length).toBe(1);
});
test('registered floating ball survives navigation without sending page text',async()=>{
 const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,origin+'/article');
 const result=await options.evaluate(({origin,tabId})=>chrome.runtime.sendMessage({type:'FLOAT_SITE',origin,tabId}),{origin,tabId});expect(result.ok).toBe(true);
 await page.reload();await expect(page.getByRole('button',{name:'墨序悬浮球 · 打开翻译面板'})).toBeVisible();expect(requests.length).toBe(0);
});

test('background completes site setup after the requesting popup closes',async()=>{
 const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,origin+'/article');
 await worker.evaluate(async()=>{await chrome.storage.local.remove('floatingOrigins');if((await chrome.scripting.getRegisteredContentScripts({ids:['qingyi-floating']})).length)await chrome.scripting.unregisterContentScripts({ids:['qingyi-floating']});});
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 const result=await popup.evaluate(({origin,tabId})=>chrome.runtime.sendMessage({type:'PREPARE_FLOAT',origin,tabId}),{origin,tabId});expect(result.ok).toBe(true);await popup.close();
 await worker.evaluate(()=>globalThis.testFinishFloating());await page.reload();
 await expect(page.getByRole('button',{name:'墨序悬浮球 · 打开翻译面板'})).toBeVisible();
 expect(requests.length).toBe(0);
});

async function selectText(selector){
 await page.locator(selector).evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
}
const selectionButton=()=>page.getByRole('button',{name:'翻译选中文字，在原文下方显示'});
const selectionOutput=()=>page.locator('[data-qingyi="selection"] .text');

test('mouse selection offers a button without API traffic and inserts a closeable translation below the original',async()=>{
 await command('launcher');const original=await page.locator('article').innerHTML();
 await page.locator('#first').click({clickCount:3});
 await expect(selectionButton()).toBeVisible();expect(requests.length).toBe(0);
 await selectionButton().click();
 await expect(page.locator('#first + [data-qingyi="selection"] .text')).toContainText('未显著降低');
 expect(JSON.parse(requests[0].body.messages[1].content).source_text).toContain('The treatment');
 await expect(page.locator('[data-qingyi="panel"]')).toHaveCount(0);
 await page.getByRole('button',{name:'关闭这条译文'}).click();
 await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);
 expect(await page.locator('article').innerHTML()).toBe(original);
});
test('selection changes without pointer events, Escape dismissal and selected-text shortcut work together',async()=>{
 await command('launcher');await page.locator('#first').evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild,0);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);getSelection().modify('extend','forward','word');});
 await expect(selectionButton()).toBeVisible();await page.keyboard.press('Escape');await expect(selectionButton()).toHaveCount(0);expect(requests.length).toBe(0);
 await page.keyboard.press('Alt+Shift+s');await expect(selectionOutput()).toContainText('示例译文');
});
test('multi-paragraph selection is inserted after the last selected paragraph with no source rewrites',async()=>{
 await command('launcher');const original=await page.locator('#first').innerHTML();
 await page.evaluate(()=>{const r=document.createRange();r.setStart(document.querySelector('#first').firstChild,4);r.setEnd(document.querySelector('#second').lastChild,30);getSelection().removeAllRanges();getSelection().addRange(r);});
 await expect(selectionButton()).toBeVisible();await selectionButton().click();
 await expect(page.locator('#second + [data-qingyi="selection"] .text')).toContainText('未显著降低');
 expect(JSON.parse(requests[0].body.messages[1].content).source_text).toContain('qubit');expect(await page.locator('#first').innerHTML()).toBe(original);
});
test('completed selection cards persist, repeat clicks are deduplicated, and clipboard copies only translated text',async()=>{
 await command('launcher');await selectText('#first');await selectionButton().click();await expect(selectionOutput()).toContainText('未显著降低');
 await selectText('#first');await selectionButton().click();await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(1);expect(requests.length).toBe(1);
 await selectText('#second a');await selectionButton().click();await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(2);
 await expect(page.locator('#second + [data-qingyi="selection"] .text')).toContainText('量子比特');
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});
 await page.locator('#second + [data-qingyi="selection"]').getByRole('button',{name:'复制译文'}).click();
 expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('量子比特可以处于状态的叠加。这不意味着它存储两个经典比特。');
 await command('restore');await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);
});
test('new selection cancels unfinished work and closing a card prevents late results',async()=>{
 behavior='slow';await command('launcher');await selectText('#first');await selectionButton().click();
 await expect.poll(()=>requests.length).toBe(1);
 await selectText('#second a');await selectionButton().click();await expect(page.locator('#first + [data-qingyi="selection"]')).toHaveCount(0);
 await expect(page.locator('#second + [data-qingyi="selection"]')).toHaveCount(1);
 await page.getByRole('button',{name:'关闭这条译文'}).click();await sleep(850);
 await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);
});
test('selection error offers inline retry and preserves the original after fixing credentials',async()=>{
 behavior='401';await command('launcher');await selectText('#first');await selectionButton().click();await expect(selectionOutput()).toContainText('密钥无效');
 await expect(page.getByRole('button',{name:'复制译文'})).toBeDisabled();
 behavior='ok';await configure('fixed-key');await page.getByRole('button',{name:'重试翻译',exact:true}).click();
 await expect(selectionOutput()).toContainText('未显著降低');await expect(page.getByRole('button',{name:'复制译文'})).toBeEnabled();
 await expect(page.locator('#first')).toContainText('The treatment');
});
test('list/table selection remains within its item, and page rescans never translate injected cards',async()=>{
 await command('launcher');await selectText('li');await selectionButton().click();await expect(page.locator('li [data-qingyi="selection"] .text')).toContainText('List items');
 await selectText('td');await selectionButton().click();await expect(page.locator('td [data-qingyi="selection"] .text')).toContainText('Table cells');
 await command('start');await expect(page.locator('td [data-qingyi="translation"] .text')).toContainText('Table cells');
 const count=requests.length;await page.locator('#dynamic').evaluate(el=>el.innerHTML='<p id="rescan">Trigger a new scan.</p>');await sleep(900);
 expect(requests.slice(count).map(r=>JSON.parse(r.body.messages[1].content).source_text).join('\n')).not.toMatch(/清译|复制译文|示例译文/);
 await expect(page.locator('li [data-qingyi="translation"]')).toHaveCount(1);await expect(page.locator('td [data-qingyi="translation"]')).toHaveCount(1);
});
test('private and mixed editable/code selections have no toolbar and are never sent',async()=>{
 await command('launcher');await selectText('[contenteditable=true]');await expect(selectionButton()).toHaveCount(0);await command('selection');expect(requests.length).toBe(0);
 await selectText('#code');await expect(selectionButton()).toHaveCount(0);await command('selection');expect(requests.length).toBe(0);
 await page.evaluate(()=>{const r=document.createRange();r.setStart(document.querySelector('#second').firstChild,0);r.setEndAfter(document.querySelector('[contenteditable=true]'));getSelection().removeAllRanges();getSelection().addRange(r);});
 await command('selection');expect(requests.length).toBe(0);
 await page.locator('input').focus();await command('selection','private-password');expect(requests.length).toBe(0);
});
test('changed and removed source blocks discard selection cards and pending work',async()=>{
 behavior='slow';await command('launcher');await selectText('#first');await selectionButton().click();await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(1);
 await page.locator('#first').evaluate(el=>el.textContent='A changed paragraph.');await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);await sleep(800);
 behavior='ok';await selectText('#second a');await selectionButton().click();await expect(selectionOutput()).toContainText('量子比特');
 await page.locator('#second').evaluate(el=>el.remove());await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);
});
test('selection toolbar preference saves and updates existing pages without exposing credentials',async()=>{
 await command('launcher');await options.reload();await options.locator('#selectionToolbar').uncheck();await options.locator('#save').click();await expect(options.locator('#status')).toContainText('设置已保存');
 await selectText('#first');await sleep(200);await expect(selectionButton()).toHaveCount(0);expect(requests.length).toBe(0);
 await command('selection');await expect(selectionOutput()).toContainText('未显著降低');
 await options.reload();await expect(options.locator('#selectionToolbar')).not.toBeChecked();
 const preferences=await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(t=>t.url===url);const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>chrome.runtime.sendMessage({type:'GET_PREFERENCES'})});return r.result;},origin+'/article');
 expect(preferences).toEqual({ok:true,selectionToolbar:false,concurrency:1});
});
test('pause stops new page requests while keeping completed translations and resume continues',async()=>{
 behavior='slow';await command('start');await expect(page.getByRole('button',{name:'暂停翻译'})).toBeVisible();await page.getByRole('button',{name:'暂停翻译'}).click();
 await expect(page.locator('[data-qingyi="panel"] .count')).toContainText('已暂停');await sleep(1000);expect(requests.length).toBe(1);
 await expect(page.locator('[data-qingyi="translation"]')).toHaveCount(1);
 behavior='ok';await page.getByRole('button',{name:'继续翻译'}).click();await expect(page.locator('#first + [data-qingyi="translation"]')).toContainText('未显著降低');
});
test('site enable/disable persists across navigation without any automatic translation requests',async()=>{
 const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,origin+'/article');
 await options.evaluate(({origin,tabId})=>chrome.runtime.sendMessage({type:'FLOAT_SITE',origin,tabId}),{origin,tabId});
 await page.reload();await selectText('#first');await expect(selectionButton()).toBeVisible();expect(requests.length).toBe(0);
 await options.evaluate(origin=>chrome.runtime.sendMessage({type:'UNFLOAT_SITE',origin}),origin);
 await expect(page.locator('[data-qingyi="launcher"]')).toHaveCount(0);await expect(selectionButton()).toHaveCount(0);
 await page.reload();await selectText('#first');await sleep(200);await expect(selectionButton()).toHaveCount(0);await expect(page.locator('[data-qingyi="launcher"]')).toHaveCount(0);expect(requests.length).toBe(0);
 // The explicit context-menu / popup action can still activate the page once.
 await command('selection');await expect(selectionOutput()).toContainText('未显著降低');
});
test('CSS-hidden content is excluded from paragraph text and neighboring context',async()=>{
 await page.locator('#first').evaluate(el=>el.insertAdjacentHTML('beforeend','<span style="display:none">Hidden medical secret</span>'));
 await command('start');await expect(page.locator('#first + [data-qingyi="translation"]')).toContainText('未显著降低');
 expect(JSON.stringify(requests.map(r=>r.body.messages))).not.toContain('Hidden medical secret');
});
test('selection preview fits narrow pages and dark mode and renders model HTML only as text',async()=>{
 await command('launcher');await page.locator('#first').evaluate(el=>el.textContent='HTML source phrase.');await selectText('#first');await selectionButton().click();
 await expect(selectionOutput()).toContainText('<img');await expect(page.locator('[data-qingyi="selection"] img')).toHaveCount(0);expect(await page.evaluate(()=>window.pwned)).toBeUndefined();
 await page.screenshot({path:'work/selection-preview.png',fullPage:true});
 await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:390,height:844});
 await expect(selectionOutput()).toBeVisible();
 const bounds=await page.locator('[data-qingyi="selection"]').boundingBox();expect(bounds.x+bounds.width).toBeLessThanOrEqual(391);
 await page.screenshot({path:'work/selection-dark-mobile-preview.png',fullPage:true});
 await page.emulateMedia({colorScheme:'light'});await page.setViewportSize({width:1280,height:720});
});

test('restoring immediately after selection prevents registration races and any late insertion',async()=>{
 behavior='slow';await command('launcher');await selectText('#first');await command('selection');await command('restore');await sleep(850);
 await expect(page.locator('[data-qingyi="selection"],[data-qingyi="panel"]')).toHaveCount(0);
});
test('closing a rate-limited selection cancels its countdown and scheduled retry',async()=>{
 behavior='429-always';await command('launcher');await selectText('#first');await selectionButton().click();await expect(selectionOutput()).toContainText('秒后自动重试');
 await page.getByRole('button',{name:'关闭这条译文'}).click();await sleep(2300);expect(requests.length).toBe(1);await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);
});
test('a change in an earlier paragraph invalidates an entire multi-paragraph selection',async()=>{
 await command('launcher');await page.evaluate(()=>{const r=document.createRange();r.setStart(document.querySelector('#first').firstChild,0);r.setEnd(document.querySelector('#second').lastChild,30);getSelection().removeAllRanges();getSelection().addRange(r);});
 await selectionButton().click();await expect(selectionOutput()).toContainText('未显著降低');await page.locator('#first').evaluate(el=>el.textContent='Updated earlier source.');
 await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);
});
test('changing language invalidates deduplication and retranslates a selected paragraph',async()=>{
 await command('launcher');await selectText('#first');await selectionButton().click();await expect(selectionOutput()).toContainText('未显著降低');
 await worker.evaluate(()=>chrome.storage.local.get('settings').then(({settings})=>chrome.storage.local.set({settings:{...settings,target:'English'}})));
 await selectText('#first');await selectionButton().click();await expect.poll(()=>requests.length).toBe(2);
 expect(requests[1].body.messages[0].content).toContain('into English');
});
test('successful selection preview and toolbar remain readable in light and dark themes',async()=>{
 await command('launcher');await selectText('#first');await expect(selectionButton()).toBeVisible();
 await page.screenshot({path:'work/selection-toolbar-preview.png',fullPage:true});
 await selectionButton().click();await expect(selectionOutput()).toContainText('未显著降低');
 await page.screenshot({path:'work/selection-translation-preview.png',fullPage:true});
 await page.emulateMedia({colorScheme:'dark'});await page.addStyleTag({content:'body{background:#12221b;color:#e0eee5}nav{background:#25382e}code{background:#25382e}'});
 await page.screenshot({path:'work/selection-dark-preview.png',fullPage:true});
 const style=await selectionOutput().evaluate(el=>({color:getComputedStyle(el).color,background:getComputedStyle(el.parentElement).backgroundColor}));
 expect(style.background).toBe('rgb(37, 35, 33)');expect(style.color).toBe('rgb(240, 233, 223)');
 await page.emulateMedia({colorScheme:'light'});
});

test('selection card controls inside linked content never navigate the underlying link',async()=>{
 await page.locator('#dynamic').evaluate(el=>el.innerHTML='<a href="/should-not-navigate"><div id="linked-paragraph">Readable text inside a linked card.</div></a>');
 await command('launcher');await selectText('#linked-paragraph');await selectionButton().click();await expect(selectionOutput()).toContainText('Readable text');
 await selectionOutput().click();expect(page.url()).toBe(origin+'/article');
 await page.getByRole('button',{name:'关闭这条译文'}).click();expect(page.url()).toBe(origin+'/article');await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);
});

test('website scripts cannot start billable translations by synthesizing clicks or hotkeys',async()=>{
 await command('launcher');await selectText('#first');await expect(selectionButton()).toBeVisible();
 await page.locator('[data-qingyi="selection-toolbar"]').evaluate(host=>host.shadowRoot.querySelector('button').click());
 await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{altKey:true,shiftKey:true,code:'KeyS',bubbles:true})));
 await sleep(150);expect(requests.length).toBe(0);await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);
 await selectionButton().click();await expect(selectionOutput()).toContainText('未显著降低');
});

test('streamed selection appears before completion and is cached only after finishing',async()=>{
 behavior='stream';await command('launcher');await selectText('#first');await selectionButton().click();
 await expect(selectionOutput()).toHaveText('该治疗');await expect(page.getByRole('button',{name:'复制译文'})).toBeDisabled();
 await expect(selectionOutput()).toContainText('置信区间');await expect(page.getByRole('button',{name:'复制译文'})).toBeEnabled();expect(requests[0].body.stream).toBe(true);
 await command('restore');await command('selection');await expect(selectionOutput()).toContainText('置信区间');expect(requests.length).toBe(1);
});
test('closing a streaming result prevents later chunks from reappearing',async()=>{
 behavior='stream';await command('launcher');await selectText('#first');await selectionButton().click();await expect(selectionOutput()).toHaveText('该治疗');
 await page.getByRole('button',{name:'关闭这条译文'}).click();await sleep(800);await expect(page.locator('[data-qingyi="selection"]')).toHaveCount(0);expect(requests.length).toBe(1);
});
test('interrupted streams show retry instead of caching partial text',async()=>{
 behavior='stream-interrupted';await command('launcher');await selectText('#first');await selectionButton().click();await expect(selectionOutput()).toContainText('传输中断');
 await expect(page.getByRole('button',{name:'复制译文'})).toBeDisabled();behavior='stream';await page.getByRole('button',{name:'重试翻译',exact:true}).click();await expect(selectionOutput()).toContainText('置信区间');expect(requests.length).toBe(2);
});
test('unsupported streaming falls back to one compatible JSON request',async()=>{
 behavior='stream-unsupported';await command('launcher');await selectText('#first');await selectionButton().click();await expect(selectionOutput()).toContainText('置信区间');
 expect(requests.map(r=>r.body.stream)).toEqual([true,false]);
});
test('speed controls persist extended timeout, parallelism, zero delay and streaming preference',async()=>{
 await options.reload();await options.locator('#concurrency').selectOption('3');await options.locator('#requestInterval').selectOption('0');await options.locator('#timeout').selectOption('180');await options.locator('#streaming').uncheck();
 await options.locator('#save').click();await expect(options.locator('#status')).toContainText('设置已保存');await options.reload();
 await expect(options.locator('#concurrency')).toHaveValue('3');await expect(options.locator('#requestInterval')).toHaveValue('0');await expect(options.locator('#timeout')).toHaveValue('180');await expect(options.locator('#streaming')).not.toBeChecked();
});
test('parallel page translation obeys the configured global limit',async()=>{
 await worker.evaluate(()=>chrome.storage.local.get('settings').then(({settings})=>chrome.storage.local.set({settings:{...settings,concurrency:2,requestInterval:100}})));
 behavior='slow';await command('start');await expect(page.locator('[data-qingyi="panel"] .count')).toContainText('5 段已译');expect(maxActive).toBe(2);
 const gaps=requests.slice(1).map((r,i)=>r.at-requests[i].at);expect(gaps.every(gap=>gap>=80)).toBe(true);
});
test('long streamed generation completes beyond the former 25-second limit',async()=>{
 test.setTimeout(45000);behavior='stream-long';await command('launcher');await selectText('#first');const started=Date.now();await selectionButton().click();
 await expect(selectionOutput()).toHaveText('该治疗');const firstVisibleMs=Date.now()-started;
 await expect(selectionOutput()).toContainText('置信区间',{timeout:40000});await expect(page.getByRole('button',{name:'复制译文'})).toBeEnabled();
 expect(Date.now()-started).toBeGreaterThan(25000);expect(requests.length).toBe(1);
 await writeFile('work/long-stream-validation.json',JSON.stringify({firstVisibleMs,completedMs:Date.now()-started,requests:requests.length,configuredTimeoutSeconds:120},null,2));
});
test('benchmark uses actual old and new pacing with the same simulated model latency',async()=>{
 test.setTimeout(45000);behavior='benchmark';
 async function measure(profile){
  await command('restore');await page.goto(origin+'/article');
  await worker.evaluate(profile=>chrome.storage.local.get('settings').then(({settings})=>chrome.storage.local.set({settings:{...settings,...profile}})),profile);
  await worker.evaluate(async()=>{const gate=await globalThis.testGate;gate.state={nextAt:0,cooldownUntil:0,strikes:0,intervalScale:1,successes:0};});
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'CLEAR_CACHE'}));requests=[];maxActive=0;
  const start=Date.now();await command('start');await expect(page.locator('[data-qingyi="panel"] .count')).toContainText('5 段已译',{timeout:25000});
  return {elapsedMs:Date.now()-start,requests:requests.length,maxConcurrent:maxActive};
 }
 const legacy=await measure({concurrency:1,requestInterval:4000,timeout:25,streaming:false});
 const current=await measure({concurrency:2,requestInterval:1000,timeout:120,streaming:true});
 expect(legacy.requests).toBe(5);expect(current.requests).toBe(5);expect(current.maxConcurrent).toBe(2);expect(current.elapsedMs).toBeLessThan(legacy.elapsedMs*.7);
 await writeFile('work/translation-performance.json',JSON.stringify({scope:'Local mock API; 1500ms model latency; 5 visible paragraphs; actual configured request intervals',legacy,current,speedup:legacy.elapsedMs/current.elapsedMs},null,2));
});
