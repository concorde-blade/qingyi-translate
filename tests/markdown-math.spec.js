import {test,expect,chromium} from '@playwright/test';
import {cp,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';

let browser,page,output;
const externalRequests=[],pageErrors=[],policyErrors=[];
async function render(source) {
  await page.evaluate(async source=>{
    const target=document.querySelector('#math-test-output');
    await globalThis.testMarkdown.renderMarkdown(source,target);
    await document.fonts.ready;
  },source);
}
const texAnnotations=()=>output.locator('annotation[encoding="application/x-tex"]').allTextContents();

test.beforeAll(async()=>{
  await mkdir('work/markdown-math',{recursive:true});
  const extension=await mkdtemp(path.resolve('work/markdown-math/extension-'));
  await cp('src',extension,{recursive:true});
  await writeFile(path.join(extension,'local-settings.js'),'export const LOCAL_SETTINGS = null;\n');
  browser=await chromium.launchPersistentContext(await mkdtemp(path.resolve('work/markdown-math/browser-')),{
    channel:'chromium',headless:true,viewport:{width:320,height:900},colorScheme:'light',reducedMotion:'reduce',
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
  });
  // Formula rendering must remain entirely local, even for hostile TeX references.
  await browser.route(/^https?:\/\//,route=>{externalRequests.push(route.request().url());return route.abort();});
  const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');
  page=await browser.newPage();
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('console',message=>{if(/Content Security Policy|Refused to|unsafe-eval|wasm-unsafe-eval/i.test(message.text()))policyErrors.push(message.text());});
  page.on('dialog',async dialog=>{pageErrors.push('Unexpected dialog: '+dialog.message());await dialog.dismiss();});
  await page.goto(`chrome-extension://${worker.url().split('/')[2]}/sidepanel.html`);
  await expect(page.locator('#model')).not.toHaveValue('');
  await page.evaluate(async()=>{
    globalThis.testMarkdown=await import(chrome.runtime.getURL('markdown.js'));
    document.querySelector('#welcome').hidden=true;
    const article=document.createElement('article');article.className='message assistant';
    const header=document.createElement('div');header.className='message-header';header.textContent='墨序';
    const target=document.createElement('div');target.id='math-test-output';target.className='message-content';
    article.append(header,target);document.querySelector('#messages').replaceChildren(article);
  });
  output=page.locator('#math-test-output');
});
test.afterAll(async()=>{await browser?.close();});
test.beforeEach(async()=>{await page.setViewportSize({width:320,height:900});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});await render('');});

test('all four TeX delimiter forms produce readable inline and display mathematics under MV3 CSP',async()=>{
  const source=String.raw`行内 $x_i^2$ 与 \(y_j + 1\)。

$$\frac{a}{b}$$

\[\sum_{i=1}^{n} i\]`;
  await render(source);
  await expect(output.locator('.katex')).toHaveCount(4);
  await expect(output.locator('.katex-display')).toHaveCount(2);
  await expect(output.locator('.katex-error')).toHaveCount(0);
  expect(await texAnnotations()).toEqual([String.raw`x_i^2`,String.raw`y_j + 1`,String.raw`\frac{a}{b}`,String.raw`\sum_{i=1}^{n} i`]);
  expect(pageErrors).toEqual([]);expect(policyErrors).toEqual([]);expect(externalRequests).toEqual([]);
});

test('subscripts, fractions, matrices and multiline aligned equations keep mathematical structure',async()=>{
  await render(String.raw`$x_{i,j}^{2}$ 与 $\frac{\alpha+\beta}{\sqrt{1+x^2}}$。

$$\begin{pmatrix}a & b \\ c & d\end{pmatrix}$$

\[
\begin{aligned}
E &= mc^2 \\
p &= \frac{E}{c}
\end{aligned}
\]`);
  await expect(output.locator('.katex')).toHaveCount(4);
  await expect(output.locator('.katex-error')).toHaveCount(0);
  expect(await output.locator('msub,msubsup').count()).toBeGreaterThan(0);
  expect(await output.locator('mfrac').count()).toBeGreaterThanOrEqual(2);
  expect(await output.locator('msqrt').count()).toBeGreaterThan(0);
  await expect(output.locator('mtable')).toHaveCount(2);
  const annotations=await texAnnotations();
  expect(annotations.some(text=>text.includes(String.raw`\begin{pmatrix}a & b \\ c & d`))).toBe(true);
  expect(annotations.some(text=>text.includes('E &= mc^2')&&text.includes(String.raw`p &= \frac{E}{c}`))).toBe(true);
});

test('formulas inside lists and tables preserve literal vertical bars and cell boundaries',async()=>{
  await render(String.raw`- 概率 $p_i = |\langle i|\psi\rangle|^2$。
- 范数 \(\lVert x\rVert_2\)。

| 对象 | 定义 |
| --- | --- |
| 绝对值 | $|x|$ |
| 内积 | $\langle\psi|\phi\rangle$ |`);
  await expect(output.locator('ul > li')).toHaveCount(2);
  await expect(output.locator('table')).toHaveCount(1);
  await expect(output.locator('thead th')).toHaveCount(2);
  await expect(output.locator('tbody tr')).toHaveCount(2);
  await expect(output.locator('tbody td')).toHaveCount(4);
  await expect(output.locator('tbody tr').nth(0).locator('td').nth(1).locator('.katex')).toHaveCount(1);
  await expect(output.locator('tbody tr').nth(1).locator('td').nth(1).locator('.katex')).toHaveCount(1);
  await expect(output.locator('.katex')).toHaveCount(4);
  expect(await texAnnotations()).toContain(String.raw`|x|`);
  expect(await texAnnotations()).toContain(String.raw`\langle\psi|\phi\rangle`);
});

test('code fences and inline code keep dollar signs and TeX delimiters literal',async()=>{
  const code=String.raw`$x_i$
\[\frac{a}{b}\]`;
  await render(['```tex',code,'```','','`$a_b$` 与 `\\(x\\)`'].join('\n'));
  await expect(output.locator('.katex')).toHaveCount(0);
  await expect(output.locator('pre code')).toHaveText(code);
  await expect(output.locator('p code')).toHaveCount(2);
  await expect(output.locator('p code').nth(0)).toHaveText('$a_b$');
  await expect(output.locator('p code').nth(1)).toHaveText(String.raw`\(x\)`);
});

test('streaming preserves incomplete formulas as text and renders them once their delimiter closes',async()=>{
  const incompleteParen=String.raw`先看 \(x_i +`;
  await render(incompleteParen);
  await expect(output.locator('.katex')).toHaveCount(0);
  await expect(output).toHaveText(incompleteParen);
  await render(String.raw`先看 \(x_i + 1\)`);
  await expect(output.locator('.katex')).toHaveCount(1);
  expect(await texAnnotations()).toEqual([String.raw`x_i + 1`]);
  const partial=String.raw`从 $\frac{x_1}{`;
  await render(partial);
  await expect(output.locator('.katex')).toHaveCount(0);
  await expect(output).toHaveText(partial);
  await render(String.raw`从 $\frac{x_1}{2}$ 得到结果。`);
  await expect(output.locator('.katex')).toHaveCount(1);
  expect(await texAnnotations()).toEqual([String.raw`\frac{x_1}{2}`]);

  const block=String.raw`$$
\begin{aligned}
a &= b \\
c &= d
\end{aligned}`;
  await render(block);
  await expect(output.locator('.katex')).toHaveCount(0);
  await expect(output).toContainText('$$');
  await render(block+'\n$$');
  await expect(output.locator('.katex-display')).toHaveCount(1);
  await expect(output.locator('mtable')).toHaveCount(1);
});

test('invalid TeX and untrusted href or HTML macros cannot execute code or inject elements',async()=>{
  await render(String.raw`$\notARealTeXCommand{x}$`);
  await expect(output).toContainText('notARealTeXCommand');
  const hostile=String.raw`$\href{javascript:globalThis.mathCompromised=true}{run}$

$\htmlClass{injected-math-class}{text}$

$\htmlId{injected-math-id}{text}$

$\htmlStyle{position:fixed;top:0}{text}$

$\includegraphics{https://example.com/math-spy.png}$

<img src=x onerror="globalThis.mathCompromised=true">

[unsafe](javascript:globalThis.mathCompromised=true)`;
  await render(hostile);
  await expect(output.locator('img,iframe,script,object,embed')).toHaveCount(0);
  await expect(output.locator('a[href^="javascript:"],a[href^="data:"]')).toHaveCount(0);
  await expect(output.locator('.injected-math-class,#injected-math-id,[style*="position:fixed"],[style*="position: fixed"]')).toHaveCount(0);
  expect(await page.evaluate(()=>globalThis.mathCompromised)).toBeUndefined();
  expect(pageErrors).toEqual([]);expect(externalRequests).toEqual([]);
});

test('long display formulas scroll inside a 320px sidebar instead of expanding the page',async()=>{
  const formula=Array.from({length:60},(_,i)=>`x_{${i+1}}`).join(' + ')+' = 0';
  await render('## 长公式\n\n$$'+formula+'$$');
  await expect(output.locator('.katex-display')).toHaveCount(1);
  const layout=await output.evaluate(target=>{
    const scroller=[target,...target.querySelectorAll('*')].find(element=>['auto','scroll'].includes(getComputedStyle(element).overflowX)&&element.scrollWidth>element.clientWidth+4);
    const result={pageFits:document.documentElement.scrollWidth<=innerWidth,hasScroller:!!scroller,scrollable:false};
    if(scroller){scroller.scrollLeft=70;result.scrollable=scroller.scrollLeft>0;scroller.scrollLeft=0;}
    return result;
  });
  expect(layout).toEqual({pageFits:true,hasScroller:true,scrollable:true});
  await page.screenshot({path:'work/markdown-math/long-formula-320.png',animations:'disabled'});
});

test('scientific Markdown remains legible in narrow light and dark sidebars',async()=>{
  const specimen=String.raw`## 量子态与概率

态矢量为 $|\psi\rangle=\alpha|0\rangle+\beta|1\rangle$，其中 $|\alpha|^2+|\beta|^2=1$。

\[
\rho=\begin{pmatrix}
|\alpha|^2 & \alpha\beta^* \\
\alpha^*\beta & |\beta|^2
\end{pmatrix}
\]

- 测得 $0$ 的概率是 $P(0)=|\alpha|^2$。
- 冯诺依曼熵：\(S(\rho)=-\operatorname{Tr}(\rho\log\rho)\)。

| 量 | 表达式 |
| --- | --- |
| 纯度 | $\operatorname{Tr}(\rho^2)$ |
| 保真度 | $|\langle\phi|\psi\rangle|^2$ |

\[
\begin{aligned}
\langle E\rangle &= \sum_i p_i E_i \\
\Delta E &= \sqrt{\langle E^2\rangle-\langle E\rangle^2}
\end{aligned}
\]`;
  await render(specimen);
  await expect(output.locator('.katex-error')).toHaveCount(0);
  expect(await output.locator('.katex').count()).toBeGreaterThanOrEqual(8);
  for(const colorScheme of ['light','dark']){
    await page.emulateMedia({colorScheme,reducedMotion:'reduce'});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`work/markdown-math/scientific-320-${colorScheme}.png`,animations:'disabled'});
  }
  expect(policyErrors).toEqual([]);expect(pageErrors).toEqual([]);expect(externalRequests).toEqual([]);
});


test('standard Markdown retains nested lists, emphasis and nested quotations around formulas',async()=>{
  await render(String.raw`1. 主要结论
   - 使用 **粗体** 标记关键概念。
   - 以 $x_i$ 表示第 $i$ 个分量。
2. 研究限制
   > 结论依赖 *给定假设*。

| 方法 | 结果 |
| --- | --- |
| 理论 | **成立** |`);
  await expect(output.locator('ol')).toHaveCount(1);
  await expect(output.locator('ol > li')).toHaveCount(2);
  await expect(output.locator('ol > li').first().locator('ul > li')).toHaveCount(2);
  await expect(output.locator('ol > li').first().locator('strong')).toHaveText('粗体');
  await expect(output.locator('ol > li').nth(1).locator('blockquote em')).toHaveText('给定假设');
  await expect(output.locator('table tbody td strong')).toHaveText('成立');
  await expect(output.locator('.katex')).toHaveCount(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('forged math markers, indented code and reference-link metadata cannot corrupt Markdown',async()=>{
  await render('&#xE000;MX999&#xE001; $x$');
  await expect(output).toContainText('MX999');
  await expect(output.locator('.katex')).toHaveCount(1);
  expect(await texAnnotations()).toEqual(['x']);
  expect(pageErrors).toEqual([]);

  await render(String.raw`    $$x_1
    \frac{a}{b}

普通段落继续保留，包含 $y$。`);
  await expect(output.locator('pre code')).toContainText('$$x_1');
  await expect(output.locator('pre code')).toContainText(String.raw`\frac{a}{b}`);
  await expect(output.locator('p')).toContainText('普通段落继续保留');
  await expect(output.locator('pre .katex')).toHaveCount(0);
  await expect(output.locator('.katex')).toHaveCount(1);
  expect(await texAnnotations()).toEqual(['y']);

  await render(String.raw`[参考文献][ref] 和 $z$。

[ref]: https://example.com/reference "保留 $x$ 原样"`);
  const link=output.getByRole('link',{name:'参考文献'});
  await expect(link).toHaveAttribute('href','https://example.com/reference');
  await expect(link).toHaveAttribute('title','保留 $x$ 原样');
  await expect(link).toHaveAttribute('target','_blank');
  await expect(output.locator('.katex')).toHaveCount(1);
  expect(await texAnnotations()).toEqual(['z']);
  const routeURL='https://example.com/reference';
  const destination=route=>route.fulfill({status:200,contentType:'text/html;charset=utf-8',body:'<!doctype html><title>Reference destination fixture</title><p>Reference destination fixture</p>'});
  await browser.route(routeURL,destination);
  try {
    const newPage=browser.waitForEvent('page');
    await link.click();
    const popup=await newPage;
    await expect(popup).toHaveURL(routeURL);
    await expect(popup.locator('body')).toContainText('Reference destination fixture');
    await popup.close();
  } finally { await browser.unroute(routeURL,destination); }
  expect(pageErrors).toEqual([]);expect(policyErrors).toEqual([]);expect(externalRequests).toEqual([]);
});
