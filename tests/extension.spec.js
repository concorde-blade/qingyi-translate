import {test,expect,chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

let context,worker,id,server,origin,options,page,requests=[],behavior='ok',active=0,maxActive=0;
const html=`<!doctype html><html lang="en"><head><title>Research notes · a reading test</title><style>body{margin:60px auto;max-width:780px;font:18px/1.8 system-ui;color:#293d37;background:#fdfdfb}h1{font-size:42px;line-height:1.2}p{margin:24px 0}nav{padding:10px;background:#eee}article{padding:20px}code{background:#eee}input{padding:10px}</style></head><body><nav>Navigation must remain untranslated</nav><article><h1>Read science, with context.</h1><p id="first">The treatment did not significantly reduce the risk. The confidence interval includes zero.</p><p id="second">A <a href="#reference">qubit</a> can be in a superposition of states. This does not imply that it stores two classical bits.</p><p id="code"><code>const secret = "do not translate";</code></p><input type="password" value="private-password"><div contenteditable="true">Private draft must not be sent</div><p hidden>Hidden secret must not be sent</p><ul><li>List items should retain their original structure.</li></ul><table><tbody><tr><td>Table cells contain readable text.</td></tr></tbody></table><div id="dynamic"></div></article></body></html>`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function command(action,text){return worker.evaluate(async({tabUrl,action,text})=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url===tabUrl);await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});return chrome.tabs.sendMessage(tab.id,{type:'PAGE_ACTION',action,text});},{tabUrl:origin+'/article',action,text});}
async function configure(apiKey='test-only'){
 await worker.evaluate(async({origin,apiKey})=>{await chrome.storage.local.set({settings:{endpoint:origin+'/v1',apiKey,model:'test-model',target:'简体中文',domain:'学术论文',glossary:'qubit = 量子比特',concurrency:2,requestInterval:50,timeout:25}});},{origin,apiKey});
}
test.beforeAll(async()=>{
 server=createServer(async(req,res)=>{
  if(req.url==='/article'){res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(html);return;}
  if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'qwen-chat'},{id:'deepseek-flash'},{id:'qwen3-embedding'}]}));return;}
  if(req.url==='/v1/chat/completions'){
   let raw='';for await(const chunk of req)raw+=chunk;
   const body=JSON.parse(raw);requests.push({body,auth:req.headers.authorization,at:Date.now()});active++;maxActive=Math.max(maxActive,active);
   const currentBehavior=behavior;
   if(currentBehavior==='slow')await sleep(700);else await sleep(50);
   active--;
   if(currentBehavior==='quota'){res.writeHead(429);res.end(JSON.stringify({error:{code:'insufficient_quota'}}));return;}
   if(currentBehavior==='429-always'){res.writeHead(429,{'Retry-After':'2'});res.end('{}');return;}
   if(currentBehavior==='401'){res.writeHead(401);res.end('{}');return;}
   if(currentBehavior==='429-once'){behavior='ok';res.writeHead(429,{'Retry-After':'1'});res.end('{}');return;}
   const source=JSON.parse(body.messages[1].content).source_text;
   const translated=source==='无需重复翻译的中文标题'?source:source.includes('treatment')?'该治疗未显著降低风险。置信区间包含零。':source.includes('qubit')?'量子比特可以处于状态的叠加。这不意味着它存储两个经典比特。':source.includes('HTML')?'<img src=x onerror="window.pwned=true">':'示例译文：'+source;
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:translated},finish_reason:'stop'}]}));return;
  }
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 const extension=path.resolve('work/test-extension');await cp('src',extension,{recursive:true});
 // Accelerate only pacing in the mock build; shipping minimum stays 4 seconds.
 await writeFile(extension+'/background.js',(await readFile(extension+'/background.js','utf8'))+'\nglobalThis.testGate=gateReady;globalThis.testFinishFloating=finishPendingFloat;');
 const coreFile=extension+'/core.js';await writeFile(coreFile,(await readFile(coreFile,'utf8')).replace('MIN_REQUEST_INTERVAL = 4000','MIN_REQUEST_INTERVAL = 50'));
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
 await command('selection','qubit');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('量子比特');
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
 await page.getByRole('button',{name:'清译悬浮球 · 打开翻译面板'}).click();await expect(body).toContainText('A collapsible phrase.');
});
test('retry resumes paragraphs added while authentication error paused the queue',async()=>{
 behavior='401';await command('start');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('密钥无效');
 await page.evaluate(()=>{const p=document.createElement('p');p.id='paused-new';p.textContent='A new paragraph loaded while translation was paused.';document.querySelector('article').prepend(p);});
 await sleep(500);behavior='ok';await configure('new-test-key');await command('retry');await expect(page.locator('#paused-new + [data-qingyi]')).toContainText('示例译文');
});
test('a selected word inside a hyperlink can still be translated',async()=>{
 await page.locator('#second a').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);});
 await command('selection');await expect(page.locator('[data-qingyi="panel"] .body')).toContainText('量子比特');
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
 await command('launcher');const ball=page.getByRole('button',{name:'清译悬浮球 · 打开翻译面板'});
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
 await page.reload();await expect(page.getByRole('button',{name:'清译悬浮球 · 打开翻译面板'})).toBeVisible();expect(requests.length).toBe(0);
});

test('background completes site setup after the requesting popup closes',async()=>{
 const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,origin+'/article');
 await worker.evaluate(async()=>{await chrome.storage.local.remove('floatingOrigins');if((await chrome.scripting.getRegisteredContentScripts({ids:['qingyi-floating']})).length)await chrome.scripting.unregisterContentScripts({ids:['qingyi-floating']});});
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 const result=await popup.evaluate(({origin,tabId})=>chrome.runtime.sendMessage({type:'PREPARE_FLOAT',origin,tabId}),{origin,tabId});expect(result.ok).toBe(true);await popup.close();
 await worker.evaluate(()=>globalThis.testFinishFloating());await page.reload();
 await expect(page.getByRole('button',{name:'清译悬浮球 · 打开翻译面板'})).toBeVisible();
 expect(requests.length).toBe(0);
});
