import katex from './vendor/katex/katex.mjs';
import MarkdownIt from './vendor/markdown-it/markdown-it.mjs';

const MAX_FORMULA_CHARS=12000, MAX_FORMULAS=250, MAX_CACHE=160, MAX_CACHE_CHARS=1500000;
const cache=new Map();let cacheChars=0;
const escaped=(text,index)=>{let count=0;while(index>0 && text[--index]==='\\')count++;return count%2===1;};
const linePrefix=(text,index)=>text.slice(text.lastIndexOf('\n',index-1)+1,index);
const fencePrefix=/^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?$/;
const boundaryParser=new MarkdownIt({html:false});
function markdownBoundaries(text) {
  const tokens=[],env={};boundaryParser.block.parse(text,boundaryParser,env,tokens);
  const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);
  const ranges=new Map();
  for(const token of tokens)if(['code_block','fence'].includes(token.type) && token.map)ranges.set(starts[token.map[0]],starts[token.map[1]]??text.length);
  return {ranges,references:env.references||{}};
}
const normalizeReference=value=>value.trim().replace(/\s+/g,' ').toLowerCase().toUpperCase();
function referenceEnd(text,start,references) {
  if(text[start]===']' && text[start+1]==='['){const end=text.indexOf(']',start+2);if(end>=0)return end+1;}
  if(text[start]!=='[')return start;
  const end=text.indexOf(']',start+1);if(end<0 || text.slice(start,end).includes('\n'))return start;
  if(text[end+1]!==':' && text[end+1]!=='(' && Object.hasOwn(references,normalizeReference(text.slice(start+1,end))))return text.slice(end+1,end+3)==='[]'?end+3:end+1;
  if(text[end+1]!==':' || !fencePrefix.test(linePrefix(text,start)) || !Object.hasOwn(references,normalizeReference(text.slice(start+1,end))))return start;
  // Reference URLs/titles can occupy multiple lines, including inside quotes.
  const whitespace=at=>{while(at<text.length && (/\s/.test(text[at]) || text[at]==='>' && /^[ \t>]*$/.test(linePrefix(text,at))))at++;return at;};
  let at=whitespace(end+2);
  if(text[at]==='<'){const close=text.indexOf('>',at+1);if(close<0)return start;at=close+1;}
  else while(at<text.length && !/\s/.test(text[at]))at++;
  const urlEnd=at,titleStart=whitespace(at),quote=text[titleStart],close=quote==='('?')':quote;
  if(!['"',"'",'('].includes(quote))return urlEnd;
  for(at=titleStart+1;at<text.length;at++)if(text[at]===close && !escaped(text,at))return at+1;
  return urlEnd;
}
function codeEnd(text,start) {
  if(escaped(text,start))return start;
  const char=text[start];if(char!=='`' && char!=='~')return start;
  let end=start;while(text[end]===char)end++;
  const run=text.slice(start,end),fenced=run.length>=3 && fencePrefix.test(linePrefix(text,start));
  if(fenced) {
    const lineEnd=text.indexOf('\n',end);if(lineEnd<0)return text.length;
    let at=lineEnd+1;
    while(at<text.length) {
      const next=text.indexOf('\n',at),stop=next<0?text.length:next;
      const content=text.slice(at,stop).replace(/^[ \t]*(?:>[ \t]*)*/,'');
      if(content.startsWith(run) && new RegExp(`^${char}{${run.length},}[ \\t]*$`).test(content))return stop;
      at=stop+1;
    }
    return text.length;
  }
  if(char==='~')return start;
  let at=end;
  while((at=text.indexOf(run,at))>=0) {
    if(text[at-1]!==char && text[at+run.length]!==char)return at+run.length;
    at+=run.length;
  }
  return start;
}
function destinationEnd(text,start) {
  if(text[start]!==']' || text[start+1]!=='(')return start;
  let depth=1,quote='';
  for(let i=start+2;i<text.length;i++) {
    if(escaped(text,i))continue;
    if(quote){if(text[i]===quote)quote='';continue;}
    if(depth===1 && /\s/.test(text[i-1]) && ['"',"'"].includes(text[i])){quote=text[i];continue;}
    if(text[i]==='(')depth++;
    if(text[i]===')' && --depth===0)return i+1;
  }
  return start;
}
function closingAt(text,start,close,singleDollar) {
  let braces=0;
  for(let i=start;i<text.length && i-start<=MAX_FORMULA_CHARS;i++) {
    if(singleDollar && text[i]==='\n')return -1;
    if(escaped(text,i))continue;
    if(text[i]==='{')braces++;
    else if(text[i]==='}')braces=Math.max(0,braces-1);
    if(!braces && text.startsWith(close,i)) {
      if(singleDollar && (/\s/.test(text[i-1]||'') || /\d/.test(text[i+1]||'') || text[i+1]==='$'))continue;
      return i;
    }
  }
  return -1;
}
// Protect TeX before Markdown sees underscores, asterisks, table pipes or line breaks.
// A collision-free marker is local to this render; original answers stay unchanged.
export function protectMath(value) {
  const text=String(value||'');let marker='\uE000MX'+crypto.randomUUID().replace(/-/g,'')+'_';
  while(text.includes(marker))marker+='X';
  const {ranges,references}=markdownBoundaries(text);
  const formulas=[];let output='',i=0;
  while(i<text.length) {
    const code=Math.max(codeEnd(text,i),ranges.get(i)||i),destination=Math.max(destinationEnd(text,i),referenceEnd(text,i,references));
    const url=/^https?:\/\/[^\s<>]+/.exec(text.slice(i));
    const skip=Math.max(code,destination,url?i+url[0].length:i);
    if(skip>i){output+=text.slice(i,skip);i=skip;continue;}
    let open='',close='',display=false,environment=false;
    if(!escaped(text,i) && formulas.length<MAX_FORMULAS) {
      if(text.startsWith('$$',i)){open=close='$$';display=true;}
      else if(text[i]==='$' && text[i+1] && !/\s/.test(text[i+1]))open=close='$';
      else if(text.startsWith('\\[',i)){open='\\[';close='\\]';display=true;}
      else if(text.startsWith('\\(',i)){open='\\(';close='\\)';}
      else {
        const env=/^\\begin\{(equation\*?|align\*?|aligned|gather\*?|gathered|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|cases|split)\}/.exec(text.slice(i));
        if(env){open=env[0];close=`\\end{${env[1]}}`;display=true;environment=true;}
      }
    }
    if(open) {
      const end=closingAt(text,i+open.length,close,open==='$');
      if(end>=0 && end>i+open.length) {
        const raw=text.slice(i,end+close.length);
        let tex=environment?raw:text.slice(i+open.length,end);
        if(/^[ \t]*>/.test(linePrefix(text,i)))tex=tex.replace(/\n[ \t]*>[ \t]?/g,'\n');
        output+=`${marker}${formulas.length}\uE001`;
        formulas.push({raw,tex,display});i=end+close.length;continue;
      }
      // Preserve incomplete streamed TeX literally, including Markdown-sensitive
      // underscores and backslashes. Currency-like dollar amounts stay prose.
      if(open!=='$' || !/^\d+(?:[.,]\d+)?(?:\s|[、，,。]|$)/.test(text.slice(i+1))) {
        const newline=text.indexOf('\n',i),stop=open==='$' && newline>=0?newline:text.length;
        output+=`${marker}${formulas.length}\uE001`;
        formulas.push({raw:text.slice(i,stop),tex:'',display:false,literal:true});i=stop;continue;
      }
    }
    output+=text[i++];
  }
  return {text:output,marker,formulas};
}
function mathHTML({tex,display}) {
  const key=(display?'D':'I')+tex;
  if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return value;}
  let result=null;
  try {result=katex.renderToString(tex,{displayMode:display,output:'htmlAndMathml',throwOnError:true,trust:false,strict:'ignore',maxExpand:1000,maxSize:20,macros:{},globalGroup:false});}
  catch { /* Invalid or unfinished TeX remains readable as its original source. */ }
  if(result && result.length<=MAX_CACHE_CHARS) {
    cache.set(key,result);cacheChars+=result.length;
    while(cache.size>MAX_CACHE || cacheChars>MAX_CACHE_CHARS){const first=cache.keys().next().value;cacheChars-=cache.get(first).length;cache.delete(first);}
  }
  return result;
}
export function restoreMath(root,{marker,formulas}) {
  if(!formulas.length)return;
  const pattern=new RegExp(`${marker}(\\d+)\uE001`,'g');
  // Attribute values remain literal text, even if unusual Markdown metadata
  // placed a protected expression in a title. Never typeset inside attributes.
  for(const element of root.querySelectorAll('[title]')) {
    const title=element.getAttribute('title');
    if(title.includes(marker))element.setAttribute('title',title.replace(pattern,(match,index)=>formulas[Number(index)]?.raw??match));
  }
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];
  while(walker.nextNode())if(walker.currentNode.nodeValue.includes(marker))nodes.push(walker.currentNode);
  for(const node of nodes) {
    const content=node.nodeValue,parts=document.createDocumentFragment();let offset=0;
    for(const match of content.matchAll(pattern)) {
      parts.append(document.createTextNode(content.slice(offset,match.index)));
      const formula=formulas[Number(match[1])];
      if(!formula){parts.append(document.createTextNode(match[0]));offset=match.index+match[0].length;continue;}
      const html=formula.literal || node.parentElement?.closest('pre,code')?null:mathHTML(formula);
      if(html) {
        const span=document.createElement('span');span.className='math-fragment '+(formula.display?'math-display':'math-inline');
        // This sink receives only KaTeX-generated HTML, never raw model markup.
        span.innerHTML=html;
        if(formula.display){span.tabIndex=0;span.setAttribute('role','group');span.setAttribute('aria-label','数学公式，可横向滚动');}
        parts.append(span);
      }else parts.append(document.createTextNode(formula.raw));
      offset=match.index+match[0].length;
    }
    parts.append(document.createTextNode(content.slice(offset)));node.replaceWith(parts);
  }
}
