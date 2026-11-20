import {test, expect, chromium} from '@playwright/test';
import {cp, mkdir, mkdtemp, writeFile, access} from 'node:fs/promises';
import path from 'node:path';
import {makeTextPDF} from './document-reader-fixtures.js';

let browser, page, extension, hasPaper = false;
const blocked = [], errors = [];
const fixtures = {
  'simple.pdf': makeTextPDF(['Hello from a local PDF.\nSecond line.', 'Page two has useful evidence.']),
  'blank.pdf': makeTextPDF(['']),
  'pages.pdf': makeTextPDF(Array.from({length:81}, (_, i) => `Unique page ${i + 1} evidence.`)),
  'long.pdf': makeTextPDF(Array.from({length:60}, (_, i) => `Page ${i + 1}.\n` + Array.from({length:20}, () => 'A sentence with searchable evidence repeated for the character limit.').join('\n'))),
  'broken.pdf': Buffer.from('%PDF-1.7\nThis is not a PDF object graph.'),
};

async function readPDF(name, options = {}) {
  return page.evaluate(async ({name,options}) => {
    const bytes = await (await fetch(name)).arrayBuffer();
    const before = bytes.byteLength;
    try { return {ok:true, document:await window.reader.readPDFBytes(bytes, options), inputBytes:bytes.byteLength, before}; }
    catch (error) { return {ok:false, code:error.code, message:error.message}; }
  }, {name,options});
}

test.beforeAll(async () => {
  await mkdir('work/document-reader', {recursive:true});
  extension = await mkdtemp(path.resolve('work/document-reader/extension-'));
  await cp('src/document-reader.js', path.join(extension, 'document-reader.js'));
  await cp('src/vendor/pdfjs', path.join(extension, 'vendor/pdfjs'), {recursive:true});
  await writeFile(path.join(extension,'manifest.json'), JSON.stringify({manifest_version:3,name:'Document reader verification',version:'1.0.0',background:{service_worker:'background.js'},content_security_policy:{extension_pages:"script-src 'self'; object-src 'self'"}}));
  await writeFile(path.join(extension,'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(path.join(extension,'reader.html'), '<!doctype html><meta charset="utf-8"><title>Local document reader</title><script type="module" src="harness.js"></script>');
  await writeFile(path.join(extension,'harness.js'), "import * as reader from './document-reader.js'; window.reader = reader;");
  for (const [name,bytes] of Object.entries(fixtures)) await writeFile(path.join(extension,name),bytes);
  try {
    await access('work/document-reader/arxiv-2611.14652.pdf');
    await cp('work/document-reader/arxiv-2611.14652.pdf', path.join(extension,'paper.pdf')); hasPaper = true;
  } catch {}
  browser = await chromium.launchPersistentContext(await mkdtemp(path.resolve('work/document-reader/browser-')), {channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Content Security Policy|Refused to|unsafe-eval|wasm-unsafe-eval/i.test(message.text())) blocked.push(message.text()); });
  await page.goto(`chrome-extension://${worker.url().split('/')[2]}/reader.html`);
  await expect.poll(() => page.evaluate(() => Boolean(window.reader))).toBe(true);
});
test.afterAll(async () => { await browser?.close(); });

test('extracts PDF text with a real local worker under strict MV3 CSP', async () => {
  const result = await readPDF('simple.pdf', {title:'Local research.pdf'});
  expect(result.ok).toBe(true);
  expect(result.document).toMatchObject({title:'Local research.pdf',kind:'pdf',pages:2,pagesRead:2,truncated:false});
  expect(result.document.text).toContain('[第 1 页]\nHello from a local PDF.\nSecond line.');
  expect(result.document.text).toContain('[第 2 页]\nPage two has useful evidence.');
  expect(result.inputBytes).toBe(result.before);
  expect(blocked).toEqual([]); expect(errors).toEqual([]);
});

test('reads a user-selected PDF File with the same local parser', async () => {
  const result = await page.evaluate(async () => {
    const bytes = await (await fetch('simple.pdf')).arrayBuffer();
    return window.reader.readLocalDocument(new File([bytes],'uploaded.pdf',{type:'application/pdf'}));
  });
  expect(result).toMatchObject({title:'uploaded.pdf',kind:'pdf',pages:2,truncated:false});
  expect(result.text).toContain('Hello from a local PDF.');
});

test('caps PDF pages and text while reporting incomplete extraction', async () => {
  const pages = await readPDF('pages.pdf');
  expect(pages.ok).toBe(true);
  expect(pages.document).toMatchObject({pages:81,pagesRead:80,truncated:true});
  expect(pages.document.text).toContain('Unique page 80 evidence.');
  expect(pages.document.text).not.toContain('Unique page 81 evidence.');
  const long = await readPDF('long.pdf');
  expect(long.ok).toBe(true); expect(long.document.truncated).toBe(true);
  expect(long.document.text.length).toBeLessThanOrEqual(48000);
  expect(long.document.text.length).toBeGreaterThan(47000);
});

test('explains scan-only and malformed PDFs without pretending to read them', async () => {
  const blank = await readPDF('blank.pdf');
  expect(blank).toMatchObject({ok:false,code:'PDF_NO_TEXT'}); expect(blank.message).toContain('OCR');
  expect(await readPDF('broken.pdf')).toMatchObject({ok:false,code:'PDF_INVALID'});
});

test('cancels an active PDF read and permits the next read', async () => {
  const result = await page.evaluate(async () => {
    const bytes = await (await fetch('long.pdf')).arrayBuffer();
    const controller = new AbortController();
    const NativeWorker = window.Worker;
    let extractionStarted = false;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...args) {
        super.postMessage(message, ...args);
        if (message.action === 'GetTextContent') {
          extractionStarted = true;
          queueMicrotask(() => controller.abort());
        }
      }
    };
    try {
      await window.reader.readPDFBytes(bytes,{signal:controller.signal});
      return {code:'unexpected success',extractionStarted};
    } catch(error) { return {code:error.code,extractionStarted}; }
    finally { window.Worker = NativeWorker; }
  });
  expect(result).toEqual({code:'CANCELLED',extractionStarted:true});
  expect((await readPDF('simple.pdf')).ok).toBe(true);
});

test('extracts the actual research paper when its local fixture is available', async () => {
  test.skip(!hasPaper, 'Public paper fixture is an optional real-document verification.');
  const result = await readPDF('paper.pdf', {title:'The memory cost of sequential quantum state preparation'});
  expect(result.ok).toBe(true);
  expect(result.document.text).toMatch(/memory cost of sequential quantum state preparation/i);
  expect(result.document.text.length).toBeGreaterThan(10000);
  expect(blocked).toEqual([]); expect(errors).toEqual([]);
  await writeFile('work/document-reader/real-paper-verification.json', JSON.stringify({title:result.document.title,pages:result.document.pages,pagesRead:result.document.pagesRead,characters:result.document.text.length,truncated:result.document.truncated,csp:"script-src 'self'; object-src 'self'",cspViolations:blocked,errors,sample:result.document.text.slice(0,2400)},null,2));
});
