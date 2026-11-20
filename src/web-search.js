import {TranslateError} from './core.js';

// Exa's hosted MCP explicitly offers keyless search with a free rate limit.
// No browser cookies, API credentials, or broader website access are used.
export const SEARCH_ORIGINS=Object.freeze(['https://mcp.exa.ai/*']);
export const SEARCH_MAX_BYTES=1048576;
export const SEARCH_TIMEOUT_MS=20000;
const ENDPOINT='https://mcp.exa.ai/mcp',REQUEST_ID=1,MAX_RESULTS=6;
export class WebSearchError extends TranslateError {}
const fail=(message,code)=>new WebSearchError(message,code);

const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',copy:'©',reg:'®',trade:'™',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',bull:'•',middot:'·',times:'×'};
function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(whole,name)=>{
    if(name[0]!=='#')return entities[name.toLowerCase()]??whole;
    const code=name[1]?.toLowerCase()==='x'?parseInt(name.slice(2),16):parseInt(name.slice(1),10);
    return code>0 && code<=0x10ffff && !(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'';
  });
}
function cleanText(value,limit) {
  if(typeof value!=='string')return '';
  return decodeEntities(decodeEntities(value))
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<[^>]*>/g,' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'')
    .replace(/\s+/g,' ').trim().slice(0,limit);
}
function safeResultURL(value) {
  if(typeof value!=='string' || value.length>4096)return null;
  let url;try{url=new URL(decodeEntities(value.trim()));}catch{return null;}
  const host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443'))return null;
  if(!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host))return null;
  const is=(domain)=>host===domain || host.endsWith('.'+domain);
  if((/(?:^|\.)google\.[a-z.]+$/.test(host) && (url.searchParams.has('q') || /^\/(?:url|search|imgres|aclk)(?:\/|$)/.test(url.pathname))) ||
     (is('bing.com') && (url.searchParams.has('q') || /^\/(?:ck|aclick|search)(?:\/|$)/.test(url.pathname))) ||
     (is('duckduckgo.com') && (url.searchParams.has('q') || url.searchParams.has('uddg') || /^\/(?:l|html|lite)(?:\/|$)/.test(url.pathname))) ||
     host==='search.yahoo.com' || host==='r.search.yahoo.com' ||
     (is('baidu.com') && /^\/(?:link|s)(?:\/|$)/.test(url.pathname)) ||
     is('googleadservices.com') || is('doubleclick.net') || host==='mcp.exa.ai')return null;
  url.hash='';
  for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key) || /^(?:gclid|fbclid|msclkid|access_token|api_key)$/i.test(key))url.searchParams.delete(key);
  return url.href;
}
function normalizeResults(candidates) {
  const results=[],seen=new Set();
  for(const item of candidates) {
    const title=cleanText(item?.title,240),url=safeResultURL(item?.url);
    if(!title || !url)continue;
    const parsed=new URL(url),key=parsed.origin+parsed.pathname.replace(/\/+$/,'')+parsed.search;
    if(seen.has(key))continue;seen.add(key);
    const raw=item.snippet??item.text??item.summary??(Array.isArray(item.highlights)?item.highlights.join(' '):item.highlights)??'';
    results.push({title,url,snippet:cleanText(raw,1400)});
    if(results.length===MAX_RESULTS)break;
  }
  return results;
}
function textResults(text) {
  // The hosted tool returns result blocks, not HTML pages or executable markup.
  const pattern=/(?:^|\n\s*---\s*\n)\s*Title:[ \t]*([^\n]*)\r?\nURL:[ \t]*([^\n]*)\r?\n([\s\S]*?)(?=\n\s*---\s*\n\s*Title:|$)/g;
  const results=[];
  for(const match of text.matchAll(pattern)) {
    const body=match[3].replace(/^(?:(?:Published(?: Date)?|Author):[^\n]*\r?\n)*/,'').replace(/^(?:Highlights|Text|Summary|Content):[ \t]*\r?\n?/,'');
    results.push({title:match[1],url:match[2],snippet:body});
  }
  return results;
}
function parseResult(packet) {
  if(packet?.error || packet?.result?.isError) {
    const text=JSON.stringify(packet.error || packet.result.content || '');
    if(/rate.?limit|too many|429|免费.*限额/i.test(text))throw fail('免费联网搜索暂时达到频率上限，请稍后重试。','SEARCH_RATE_LIMIT');
    throw fail('联网搜索服务暂时不可用，请稍后重试。','SEARCH_SERVICE');
  }
  const result=packet?.result;
  if(!result || typeof result!=='object')throw fail('搜索服务返回的内容无法识别，请稍后重试。','SEARCH_RESPONSE');
  const candidates=[];
  if(Array.isArray(result.structuredContent?.results))candidates.push(...result.structuredContent.results);
  for(const content of Array.isArray(result.content)?result.content:[]) {
    if(content.type!=='text' || typeof content.text!=='string')continue;
    let structured;try{structured=JSON.parse(content.text);}catch{}
    if(Array.isArray(structured?.results))candidates.push(...structured.results);
    else candidates.push(...textResults(content.text));
  }
  const results=normalizeResults(candidates);
  if(!results.length)throw fail('没有找到可用的搜索结果，请换用更具体的关键词。','SEARCH_EMPTY');
  return results;
}
function abortReason(signal,timedOut) {
  return timedOut()?fail('联网搜索超过 20 秒，已停止等待，请稍后重试。','SEARCH_TIMEOUT'):fail('已停止联网搜索。','CANCELLED');
}
function abortable(promise,signal,timedOut) {
  if(signal.aborted)return Promise.reject(abortReason(signal,timedOut));
  return new Promise((resolve,reject)=>{
    const stop=()=>reject(abortReason(signal,timedOut));
    signal.addEventListener('abort',stop,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
  });
}
async function readPacket(response,signal,timedOut) {
  const declared=Number(response.headers.get('Content-Length'));
  if(Number.isFinite(declared) && declared>SEARCH_MAX_BYTES)throw fail('搜索结果过大，已停止读取。','SEARCH_SIZE');
  if(!response.body?.getReader)throw fail('搜索服务没有返回内容，请稍后重试。','SEARCH_RESPONSE');
  const reader=response.body.getReader(),decoder=new TextDecoder(),stream=/text\/event-stream/i.test(response.headers.get('Content-Type')||'');
  let bytes=0,buffer='',data=[];
  const packet=value=>{
    let parsed;try{parsed=JSON.parse(value);}catch{throw fail('搜索服务返回的内容格式不正确，请稍后重试。','SEARCH_RESPONSE');}
    return parsed?.id===REQUEST_ID?parsed:null;
  };
  const line=value=>{
    if(value.endsWith('\r'))value=value.slice(0,-1);
    if(value.startsWith('data:')){data.push(value.slice(5).replace(/^ /,''));return null;}
    if(!value && data.length){const value=data.join('\n');data=[];return packet(value);}
    return null;
  };
  try {
    while(true) {
      const chunk=await abortable(reader.read(),signal,timedOut);
      if(chunk.done)break;
      bytes+=chunk.value.byteLength;
      if(bytes>SEARCH_MAX_BYTES)throw fail('搜索结果过大，已停止读取。','SEARCH_SIZE');
      buffer+=decoder.decode(chunk.value,{stream:true});
      if(stream) {
        let at;
        while((at=buffer.indexOf('\n'))>=0) {
          const result=line(buffer.slice(0,at));buffer=buffer.slice(at+1);
          if(result)return result;
        }
      }
    }
    buffer+=decoder.decode();
    if(!stream) {
      const result=packet(buffer);if(result)return result;
    } else {
      if(buffer){const result=line(buffer);if(result)return result;}
      if(data.length){const result=packet(data.join('\n'));if(result)return result;}
    }
    throw fail('搜索结果传输中断，请稍后重试。','SEARCH_RESPONSE');
  } finally {
    reader.cancel().catch(()=>{});
    try{reader.releaseLock();}catch{}
  }
}

export async function webSearch(query,{signal,fetchImpl=fetch}={}) {
  if(typeof query!=='string' || !query.trim() || query.trim().length>300)throw fail('搜索词需为 1 到 300 个字符。','SEARCH_QUERY');
  query=query.trim().replace(/\s+/g,' ');
  const controller=new AbortController();let timedOut=false;
  const stop=()=>controller.abort();
  if(signal?.aborted)throw fail('已停止联网搜索。','CANCELLED');
  signal?.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},SEARCH_TIMEOUT_MS);
  try {
    const response=await abortable(fetchImpl(ENDPOINT,{
      method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal,
      body:JSON.stringify({jsonrpc:'2.0',id:REQUEST_ID,method:'tools/call',params:{name:'web_search_exa',arguments:{query,numResults:MAX_RESULTS}}})
    }),controller.signal,()=>timedOut);
    if(!response.ok) {
      if(response.status===429)throw fail('免费联网搜索暂时达到频率上限，请稍后重试。','SEARCH_RATE_LIMIT');
      if([401,403].includes(response.status))throw fail('免费搜索在当前网络暂不可用，请检查网络后重试。','SEARCH_ACCESS');
      throw fail(`搜索服务暂时异常（HTTP ${response.status}），请稍后重试。`,'SEARCH_HTTP');
    }
    if(response.url && new URL(response.url).origin!==new URL(ENDPOINT).origin)throw fail('搜索服务发生了意外跳转，已停止请求。','SEARCH_RESPONSE');
    const packet=await readPacket(response,controller.signal,()=>timedOut);
    return {query,provider:'Exa',results:parseResult(packet)};
  } catch(error) {
    if(controller.signal.aborted)throw abortReason(controller.signal,()=>timedOut);
    if(error instanceof WebSearchError)throw error;
    throw fail('无法连接联网搜索，请检查网络后重试。','SEARCH_NETWORK');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort();}
}
