// Public links are fetched directly, without browser cookies or a third-party reader.
export function publicSourceURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('链接格式不正确'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.port && !['80','443'].includes(url.port) ||
      !host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host) || /\.(local|localhost|internal|lan)$/.test(host)) throw new Error('仅支持公开网页链接');
  if ([...url.searchParams.keys()].some(key => /^(access_?token|token|api_?key|authorization|password|secret|signature|x-amz-credential|x-amz-signature)$/i.test(key))) throw new Error('此链接含有私密访问参数，请改用公开链接或上传文件');
  url.hash = ''; return url.href;
}
export function sourceURLs(text) {
  const values = String(text).match(/https?:\/\/[^\s<>"「」]+/g) || [];
  return [...new Set(values.map(value => value.replace(/[),.;!?，。；！？）\]】]+$/, '')).map(publicSourceURL))];
}
export function extractHTMLSource(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = (doc.querySelector('title')?.textContent || new URL(url).hostname).trim().slice(0, 240);
  doc.querySelectorAll('script,style,noscript,template,iframe,object,embed,form,input,textarea,select,button,nav,header,footer,aside,[hidden],[aria-hidden="true"],[contenteditable="true"]').forEach(node => node.remove());
  const root = doc.querySelector('article,main,[role="main"]') || doc.body;
  let text = '';
  function walk(node) {
    if (text.length > 48000) return;
    if (node.nodeType === 3) { text += node.textContent.replace(/[\t\r\n ]+/g, ' '); return; }
    if (node.nodeType !== 1 || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style') || '')) return;
    const block = /^(P|DIV|SECTION|ARTICLE|H[1-6]|LI|BLOCKQUOTE|PRE|TR|BR)$/.test(node.tagName);
    if (block) text += '\n';
    for (const child of node.childNodes) walk(child);
    if (block) text += '\n';
  }
  if (root) walk(root);
  text = text.replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 30) throw new Error('网页没有可读取的正文，请打开网页后使用“附加网页”');
  return {title,url,text:text.slice(0,48000),truncated:text.length>48000,kind:'web'};
}
export async function readRemoteDocument(value, {signal, fetchImpl = fetch} = {}) {
  if (signal?.aborted) throw new Error('已停止读取');
  const url = publicSourceURL(value);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort',stop,{once:true});
  const timer = setTimeout(stop,45000), combined = controller.signal;
  const abortable = promise => {
    if (combined.aborted) return Promise.reject(combined.reason);
    return new Promise((resolve,reject) => {
      const abort = () => reject(combined.reason);
      combined.addEventListener('abort',abort,{once:true});
      Promise.resolve(promise).then(resolve,reject).finally(() => combined.removeEventListener('abort',abort));
    });
  };
  try {
  let response;
  try { response = await abortable(fetchImpl(url, {signal:combined,credentials:'omit',redirect:'error',cache:'no-store'})); }
  catch (error) { if (combined.aborted) throw new Error(signal?.aborted ? '已停止读取' : '读取链接超时，请重试'); throw new Error('无法读取链接。可在浏览器打开后附加网页，或下载文件再导入'); }
  if (!response.ok) { response.body?.cancel().catch(() => {}); throw new Error(`网页返回 ${response.status}，请打开链接确认可访问`); }
  const maxBytes = 20 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) { response.body?.cancel().catch(() => {}); throw new Error('文件超过 20 MB，请选择较小的文件'); }
  const reader = response.body?.getReader();
  let bytes;
  if (reader) {
    const chunks = []; let size = 0;
    try { while (true) { const {done,value:chunk} = await abortable(reader.read()); if (done) break; size += chunk.length; if (size > maxBytes) throw new Error('文件超过 20 MB，请选择较小的文件'); chunks.push(chunk); } }
    catch (error) { reader.cancel().catch(() => {}); throw error; }
    bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) {bytes.set(chunk,at);at += chunk.length;}
  } else bytes = new Uint8Array(await abortable(response.arrayBuffer()));
  if (bytes.length > maxBytes) throw new Error('文件超过 20 MB，请选择较小的文件');
  const type = response.headers.get('content-type') || '';
  const start = new TextDecoder().decode(bytes.subarray(0,1024));
  if (type.includes('application/pdf') || start.startsWith('%PDF-')) {
    const {readPDFBytes} = await import('./document-reader.js');
    let title = new URL(url).pathname.split('/').pop() || 'PDF'; try { title = decodeURIComponent(title); } catch {}
    const result = await readPDFBytes(bytes, {title,signal:combined});
    return {...result,url};
  }
  if (type.includes('text/html') || /<!doctype html|<html[\s>]/i.test(start)) {
    if (bytes.length > 3 * 1024 * 1024) throw new Error('网页过大，请在浏览器打开后附加正文');
    return extractHTMLSource(new TextDecoder().decode(bytes),url);
  }
  if (/text\/|application\/(json|xml)/i.test(type)) {
    const text = new TextDecoder().decode(bytes).trim();
    if (!text) throw new Error('文件没有可读取的文字');
    return {title:new URL(url).pathname.split('/').pop() || new URL(url).hostname,url,text:text.slice(0,48000),truncated:text.length>48000,kind:'text'};
  }
  throw new Error('暂不支持此链接的文件格式，请上传 PDF 或文本文件');
  } catch (error) {
    if (combined.aborted) throw new Error(signal?.aborted ? '已停止读取' : '读取链接超时，请重试');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',stop); controller.abort(); }
}
