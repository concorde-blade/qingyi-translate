import {DEFAULTS,USTC_ENDPOINT,USTC_MODEL,validateSettings,endpointURL} from './core.js';
const $=id=>document.getElementById(id);
const fields=['endpoint','model','apiKey','target','domain','glossary','timeout','concurrency','requestInterval'];
const show=(text,error=false)=>{$('status').textContent=text;$('status').className='status '+(error?'error':'success');};
let dirty=false;
function collect(){return Object.fromEntries(fields.map(key=>[key,$(key).value]));}
function populate(s){for(const key of fields)$(key).value=s[key];$('preset').value=new URL(s.endpoint).hostname==='api.llm.ustc.edu.cn'?'ustc':new URL(s.endpoint).hostname==='api.deepseek.com'?'deepseek':/^http:\/\/(localhost|127\.0\.0\.1):11434(?:\/|$)/.test(s.endpoint)?'ollama':'custom';}
$('form').addEventListener('input',()=>{dirty=true;});
$('preset').onchange=()=>{
  dirty=true;
  if($('preset').value==='ustc'){$('endpoint').value=USTC_ENDPOINT;$('model').value=USTC_MODEL;$('apiKey').value='';}
  if($('preset').value==='deepseek'){$('endpoint').value='https://api.deepseek.com';$('model').value='deepseek-flash';$('apiKey').value='';}
  if($('preset').value==='ollama'){$('endpoint').value='http://localhost:11434/v1';$('model').value='qwen3:8b';$('apiKey').value='';}
  if($('preset').value==='custom'){$('endpoint').value='';$('model').value='';$('apiKey').value='';$('endpoint').focus();}
};
$('form').onsubmit=async event=>{
  event.preventDefault();
  try{
    const s=validateSettings(collect());
    // Keep permission request in the user gesture; no await before this call.
    const permission=chrome.permissions.request({origins:[`${endpointURL(s.endpoint).origin}/*`]});
    if(!await permission){show('未获得接口访问权限，设置没有保存。',true);return;}
    const result=await chrome.runtime.sendMessage({type:'SAVE',settings:s});
    if(!result.ok)throw new Error(result.error);
    dirty=false;show('设置已保存。可以测试连接，然后到网页点击“翻译当前网页”。');
  }catch(e){show(e.message,true);}
};
$('test').onclick=async()=>{
  if(dirty){show('请先保存当前修改，再测试连接。',true);return;}
  $('test').disabled=true;$('testOutput').textContent='';show('正在测试已保存的服务…');
  try{
    const result=await chrome.runtime.sendMessage({type:'TRANSLATE',text:'The treatment did not significantly reduce the risk.',context:{title:'Connection test',before:'Clinical trial results; preserve the negation and uncertainty.'},runId:'connection-test'});
    if(!result.ok)throw new Error(result.error);
    show('连接成功。请核对译文是否保留“没有显著降低”的含义。');$('testOutput').textContent=result.text;
  }catch(e){show(e.message,true);}finally{$('test').disabled=false;}
};
$('models').onclick=async()=>{
  if(dirty){show('请先保存接口地址和密钥，再读取模型。',true);return;}
  $('models').disabled=true;show('正在读取可用模型…');
  try{
    const result=await chrome.runtime.sendMessage({type:'MODELS'});
    if(!result.ok)throw new Error(result.error);
    $('modelList').replaceChildren(...result.models.map(id=>{const option=document.createElement('option');option.value=id;return option;}));
    $('modelsHelp').textContent='已读取 '+result.models.length+' 个文本模型。点击模型名称输入框选择，也可以手动填写。';
    show('模型列表已更新；若修改模型，请再次保存。');
  }catch(e){show(e.message,true);}finally{$('models').disabled=false;}
};
$('clear').onclick=async()=>{await chrome.runtime.sendMessage({type:'CLEAR_CACHE'});show('翻译缓存已清除。');};
const loaded=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
if(loaded.ok)populate(loaded.settings);else show(loaded.error,true);
