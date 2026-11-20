import {TranslateError} from './core.js';

export const HISTORY_LIMITS=Object.freeze({conversations:40,messages:60,messageChars:100000,bytes:4000000});
const roles=new Set(['user','assistant']);
const statuses=new Set(['pending','done','error','stopped']);
const modes=new Set(['chat','summarize','research','explain','rewrite','translate']);
const phases=new Set(['waiting','reading','searching','generating','streaming']);
export function conversationId(value) {
  if(typeof value!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))throw new TranslateError('对话标识无效，请新建对话后重试。','INVALID_REQUEST');
  return value;
}
function field(value,max,name,fallback='') {
  if(value==null)return fallback;
  if(typeof value!=='string' || value.length>max)throw new TranslateError(`${name}格式不正确或超过保存上限。`,'TEXT_SIZE');
  return value;
}
function sourceReference(value) {
  if(value==null)return undefined;
  if(typeof value!=='object' || Array.isArray(value))throw new TranslateError('参考网页格式不正确。','INVALID_REQUEST');
  const title=field(value.title,500,'网页标题'),raw=field(value.url,4096,'网页地址');
  let url='';
  if(raw) {
    let parsed;try{parsed=new URL(raw);}catch{throw new TranslateError('参考网页地址格式不正确。','INVALID_REQUEST');}
    if(!['http:','https:'].includes(parsed.protocol))throw new TranslateError('参考网页地址必须是普通网页。','INVALID_REQUEST');
    parsed.search='';parsed.hash='';parsed.username='';parsed.password='';url=parsed.href;
  }
  return {title,url,truncated:value.truncated===true};
}
// Whitelist fields so service credentials and raw attached pages cannot enter history.
export function normalizeConversation(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || !Array.isArray(value.messages) || !value.messages.length || value.messages.length>HISTORY_LIMITS.messages)throw new TranslateError('对话记录格式不正确，最多保存 60 条消息。','INVALID_REQUEST');
  const id=conversationId(value.id),model=field(value.model,160,'模型名称');
  const messages=value.messages.map(message=>{
    if(!message || !roles.has(message.role))throw new TranslateError('对话记录包含不支持的消息。','INVALID_REQUEST');
    const result={
      id:conversationId(message.id),role:message.role,content:field(message.content,HISTORY_LIMITS.messageChars,'消息'),
      status:statuses.has(message.status)?message.status:'done',
      created:Number.isFinite(message.created)?Math.max(0,message.created):Date.now()
    };
    if(message.role==='assistant')result.model=field(message.model,160,'模型名称',model);
    if(message.mode!=null && modes.has(message.mode))result.mode=message.mode;
    if(message.phase!=null && phases.has(message.phase))result.phase=message.phase;
    if(message.error)result.error=field(message.error,2000,'错误说明');
    const source=sourceReference(message.source);if(source)result.source=source;
    if(message.contextRequired===true)result.contextRequired=true;
    if(Array.isArray(message.files))result.files=message.files.slice(0,4).filter(value=>typeof value==='string').map(value=>value.slice(0,500));
    if(Array.isArray(message.searchSources))result.searchSources=message.searchSources.slice(0,6).map(value=>sourceReference(value)).filter(Boolean);
    return result;
  });
  const defaultTitle=(messages.find(message=>message.role==='user')?.content || '新对话').replace(/\s+/g,' ').slice(0,40);
  return {id,title:field(value.title,100,'对话标题',defaultTitle),updated:Number.isFinite(value.updated)?Math.max(0,value.updated):Date.now(),model,messages};
}
export function normalizeHistory(value) {
  const byId=new Map();
  for(const candidate of Array.isArray(value)?value:[]) {
    try {const conversation=normalizeConversation(candidate);byId.set(conversation.id,conversation);}catch {}
  }
  return [...byId.values()].sort((a,b)=>b.updated-a.updated).slice(0,HISTORY_LIMITS.conversations);
}
export function boundHistory(value) {
  const history=normalizeHistory(value),encoder=new TextEncoder();
  const oversized=()=>encoder.encode(JSON.stringify(history)).length>HISTORY_LIMITS.bytes;
  while(history.length>1 && oversized())history.pop();
  while(history[0]?.messages.length>1 && oversized())history[0].messages.shift();
  return history;
}
