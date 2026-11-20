export const DOCUMENT_LIMITS = Object.freeze({bytes:20 * 1024 * 1024, pages:80, chars:48000, timeout:60000});

export class DocumentReadError extends Error {
  constructor(message, code) { super(message); this.name = 'DocumentReadError'; this.code = code; }
}
const cancelled = () => new DocumentReadError('已取消读取文档。', 'CANCELLED');
const checkSignal = signal => { if (signal?.aborted) throw cancelled(); };
const cleanTitle = value => String(value || '未命名文档').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0,240) || '未命名文档';
function clipText(text, limit = DOCUMENT_LIMITS.chars) {
  let result = text.slice(0, limit);
  if (/^[\uD800-\uDBFF]$/.test(result.at(-1) || '')) result = result.slice(0,-1);
  return result;
}
function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function validateSize(size) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new DocumentReadError('文档为空，无法读取。', 'DOCUMENT_EMPTY');
  if (size > DOCUMENT_LIMITS.bytes) throw new DocumentReadError('单个文件最多 20 MB，请压缩文件或拆分后再试。', 'DOCUMENT_TOO_LARGE');
}
function byteView(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new DocumentReadError('PDF 数据格式不正确。', 'PDF_INVALID');
}
function decodeText(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  let text;
  try { text = new TextDecoder(encoding, {fatal:true}).decode(bytes); }
  catch { throw new DocumentReadError('无法识别文本编码，请另存为 UTF-8 文本后重新添加。', 'TEXT_ENCODING'); }
  if (text.includes('\0')) throw new DocumentReadError('这个文件不像纯文本，请使用 TXT、Markdown、CSV、JSON 或 PDF。', 'DOCUMENT_TYPE');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

/** Read a user-chosen file locally. No file data is sent to a network service here. */
export async function readLocalDocument(file, {signal} = {}) {
  checkSignal(signal);
  if (!file || typeof file.arrayBuffer !== 'function') throw new DocumentReadError('请选择一个本机文件。', 'DOCUMENT_TYPE');
  validateSize(file.size);
  const title = cleanTitle(file.name), extension = title.match(/\.([^.]+)$/)?.[1].toLowerCase();
  const textKinds = {txt:'text', log:'text', md:'markdown', markdown:'markdown', csv:'csv', json:'json'};
  const mimeKinds = {'text/plain':'text', 'text/markdown':'markdown', 'text/csv':'csv', 'application/json':'json'};
  const kind = extension === 'pdf' || file.type === 'application/pdf' ? 'pdf' : textKinds[extension] || (!extension && mimeKinds[file.type]);
  if (!kind) throw new DocumentReadError('暂时支持 PDF、TXT、LOG、Markdown、CSV 和 JSON 文件。', 'DOCUMENT_TYPE');
  const bytes = new Uint8Array(await withSignal(file.arrayBuffer(), signal));
  checkSignal(signal); validateSize(bytes.byteLength);
  if (kind === 'pdf') return readPDFBytes(bytes, {title,signal});
  const text = decodeText(bytes);
  if (!text) throw new DocumentReadError('文件中没有可读取的文字。', 'DOCUMENT_EMPTY');
  return {title, text:clipText(text), truncated:text.length > DOCUMENT_LIMITS.chars, kind};
}

let pdfLibrary;
async function loadPDFLibrary() {
  // The official legacy distribution includes compatibility helpers for Chrome 116+.
  pdfLibrary ||= import('./vendor/pdfjs/pdf.min.mjs').catch(error => { pdfLibrary = null; throw error; });
  return pdfLibrary;
}
async function disposePDF(task, worker, port) {
  let timer;
  try {
    if (task) await Promise.race([task.destroy().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 750); })]);
  } finally {
    clearTimeout(timer);
    try { worker?.destroy(); } catch {}
    try { port?.terminate(); } catch {}
  }
}

/** Parse PDF bytes in an extension-local worker; never execute PDF scripts or render forms. */
export async function readPDFBytes(input, {title = 'PDF 文档', signal} = {}) {
  checkSignal(signal);
  const original = byteView(input); validateSize(original.byteLength);
  if (!new TextDecoder('latin1').decode(original.subarray(0,1024)).includes('%PDF-')) throw new DocumentReadError('返回内容不是有效 PDF，请确认链接指向 PDF 文件。', 'PDF_INVALID');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once:true});
  let timedOut = false, task, worker, port;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, DOCUMENT_LIMITS.timeout);
  try {
    const pdfjs = await withSignal(loadPDFLibrary(), controller.signal);
    checkSignal(controller.signal);
    const workerURL = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    pdfjs.GlobalWorkerOptions.workerSrc = workerURL;
    // Explicitly supply the local port so PDF.js cannot create a blob or remote-worker wrapper.
    port = new Worker(workerURL, {type:'module', name:'moxu-pdf-reader'});
    worker = new pdfjs.PDFWorker({port});
    task = pdfjs.getDocument({
      data:original.slice(), worker,
      isEvalSupported:false, useWasm:false, enableXfa:false, disableFontFace:true,
      isOffscreenCanvasSupported:false, isImageDecoderSupported:false,
      cMapUrl:new URL('./vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked:true,
      standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
      useWorkerFetch:true, verbosity:0,
    });
    const document = await withSignal(task.promise, controller.signal);
    const totalPages = document.numPages, pageLimit = Math.min(totalPages,DOCUMENT_LIMITS.pages);
    let text = '', truncated = totalPages > pageLimit, pagesRead = 0, readableCharacters = 0, budgetExhausted = false;
    const append = value => {
      const remaining = DOCUMENT_LIMITS.chars - text.length;
      if (value.length > remaining) { truncated = true; budgetExhausted = true; }
      text += clipText(value, Math.max(0,remaining));
      if (text.length >= DOCUMENT_LIMITS.chars) budgetExhausted = true;
    };
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
      checkSignal(controller.signal);
      if (text.length >= DOCUMENT_LIMITS.chars) { truncated = true; break; }
      const page = await withSignal(document.getPage(pageNumber), controller.signal);
      const reader = page.streamTextContent({includeMarkedContent:false}).getReader();
      let pageStarted = false, previous = '';
      pagesRead = pageNumber;
      try {
        while (!budgetExhausted) {
          const chunk = await withSignal(reader.read(), controller.signal);
          if (chunk.done) break;
          for (const item of chunk.value.items || []) {
            if (typeof item.str !== 'string') continue;
            const value = item.str.replace(/\0/g, '');
            if (!pageStarted && value.trim()) { append(`${text ? '\n\n' : ''}[第 ${pageNumber} 页]\n`); pageStarted = true; }
            if (!pageStarted) continue;
            if (previous && !/\s$/.test(previous) && value && !/^\s/.test(value) && !(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(previous) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value))) append(' ');
            append(value); readableCharacters += value.trim().length;
            if (item.hasEOL) { append('\n'); previous = '\n'; } else previous = value;
            if (budgetExhausted) { truncated = true; break; }
          }
        }
      } finally {
        // PDF.js requires an Error reason to mark a stream closed before queued worker messages arrive.
        // Do not await this handshake: the worker may have closed the stream already.
        void reader.cancel(new Error('PDF text reading finished.')).catch(() => {});
        page.cleanup();
      }
      if (budgetExhausted) { if (pageNumber < totalPages) truncated = true; break; }
    }
    checkSignal(controller.signal);
    if (!readableCharacters) throw new DocumentReadError('这个 PDF 没有可提取的文字层，可能是扫描件。请先使用 OCR 识别文字后再添加。', 'PDF_NO_TEXT');
    return {title:cleanTitle(title), text:text.trim(), truncated, kind:'pdf', pages:totalPages, pagesRead};
  } catch (error) {
    if (timedOut) throw new DocumentReadError('PDF 解析超时，请尝试较小的文件或拆分文档。', 'PDF_TIMEOUT');
    if (signal?.aborted || controller.signal.aborted) throw cancelled();
    if (error instanceof DocumentReadError) throw error;
    if (error?.name === 'PasswordException') throw new DocumentReadError('这个 PDF 有密码保护。请先在本机解锁后再添加。', 'PDF_PASSWORD');
    if (error?.name === 'InvalidPDFException') throw new DocumentReadError('PDF 无法解析，文件可能已损坏。', 'PDF_INVALID');
    throw new DocumentReadError('无法读取这个 PDF，请确认文件完整且包含可读取的文字层。', 'PDF_PARSE');
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    await disposePDF(task, worker, port);
  }
}
