import {DEFAULTS,USTC_ENDPOINT,USTC_MODEL,validateSettings,endpointURL} from './core.js';
const $=id=>document.getElementById(id);
const fields=['endpoint','model','apiKey','target','domain','glossary','timeout','concurrency','requestInterval'];
const show=(text,error=false)=>{$('status').textContent=text;$('status').className='status '+(error?'error':'success');};
let dirty=false;
function collect(){return {...Object.fromEntries(fields.map(key=>[key,$(key).value])),selectionToolbar:$('selectionToolbar').checked,streaming:$('streaming').checked};}
function populate(s){for(const key of fields){if(![...($(key).options||[])].some(option=>option.value===String(s[key])) && $(key).tagName==='SELECT'){const option=document.createElement('option');option.value=String(s[key]);option.textContent=String(s[key])+' · 当前值';$(key).append(option);}$(key).value=s[key];}$('selectionToolbar').checked=s.selectionToolbar!==false;$('streaming').checked=s.streaming!==false;$('preset').value=new URL(s.endpoint).hostname==='api.llm.ustc.edu.cn'?'ustc':new URL(s.endpoint).hostname==='api.deepseek.com'?'deepseek':new URL(s.endpoint).hostname==='api.openai.com'?'openai':/^http:\/\/(localhost|127\.0\.0\.1):11434(?:\/|$)/.test(s.endpoint)?'ollama':'custom';}
$('form').addEventListener('input',event=>{if(!['profileName','serviceProfiles'].includes(event.target.id))dirty=true;});
$('preset').onchange=()=>{
  dirty=true;
  if($('preset').value==='ustc'){$('endpoint').value=USTC_ENDPOINT;$('model').value=USTC_MODEL;$('apiKey').value='';}
  if($('preset').value==='deepseek'){$('endpoint').value='https://api.deepseek.com';$('model').value='deepseek-flash';$('apiKey').value='';}
  if($('preset').value==='openai'){$('endpoint').value='https://api.openai.com/v1';$('model').value='';$('apiKey').value='';$('model').focus();}
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
$('clear').onclick=async()=>{try{const result=await chrome.runtime.sendMessage({type:'CLEAR_CACHE'});if(!result.ok)throw new Error(result.error);show('翻译缓存已清除。');}catch(error){show(error.message,true);}};
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
const loaded=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
if(loaded.ok)populate(loaded.settings);else show(loaded.error,true);

// Service credentials remain in the same trusted local storage as the active settings.
let profiles=[];
async function loadProfiles(){
  const stored=(await chrome.storage.local.get('serviceProfiles')).serviceProfiles;
  profiles=Array.isArray(stored)?stored.filter(p=>p&&typeof p.name==='string'&&typeof p.endpoint==='string').slice(0,12):[];
  $('serviceProfiles').replaceChildren(...(profiles.length?profiles.map((p,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=p.name;return option;}):[new Option('尚未保存服务档案','')]));
  $('loadProfile').disabled=!profiles.length;
}
$('saveProfile').onclick=async()=>{
  try{
    const name=$('profileName').value.trim();if(!name)throw new Error('请为服务档案填写一个名称。');
    const settings=validateSettings(collect());
    const profile={name:name.slice(0,40),endpoint:settings.endpoint,model:settings.model,apiKey:settings.apiKey};
    const at=profiles.findIndex(p=>p.name===profile.name);
    if(at<0&&profiles.length>=12)throw new Error('最多保存 12 个服务档案；填写已有名称可更新对应档案。');
    const next=profiles.slice();if(at<0)next.push(profile);else next[at]=profile;
    await chrome.storage.local.set({serviceProfiles:next});await loadProfiles();
    $('serviceProfiles').value=String(at<0?profiles.length-1:at);
    show('服务档案已保存在本机。点击“保存并授权”可启用当前表单中的配置。');
  }catch(error){show(error.message,true);}
};
$('loadProfile').onclick=()=>{
  const profile=profiles[Number($('serviceProfiles').value)];if(!profile)return;
  populate({...collect(),...profile});$('profileName').value=profile.name;dirty=true;
  show('已载入“'+profile.name+'”。点击“保存并授权”后，对话与翻译将使用这个服务。');
};
await loadProfiles();
