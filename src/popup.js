const status=document.querySelector('#status');
const send=message=>chrome.runtime.sendMessage(message);
let tab;
function show(text,error=false){status.textContent=text;status.className='status'+(error?' error':'');}
document.querySelector('#settings').onclick=()=>chrome.runtime.openOptionsPage();
async function action(action){
  try{
    if(!tab?.id)throw new Error('没有找到当前网页。');
    const result=await send({type:'PAGE',tabId:tab.id,action});
    if(!result.ok)throw new Error(result.error);
    if(action==='start'||action==='selection')window.close();
    else show('已恢复原文。');
  }catch(e){show(e.message,true);}
}
document.querySelector('#translate').onclick=()=>action('start');
document.querySelector('#selection').onclick=()=>action('selection');
document.querySelector('#restore').onclick=()=>action('restore');
try{
  [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const result=await send({type:'GET_SETTINGS'});
  if(!result.ok)throw new Error(result.error);
  const s=result.settings;
  if(!s.apiKey&&!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(s.endpoint)){
    show('首次使用：先在设置中填写 API 地址、模型和密钥。');
    document.querySelector('#translate').textContent='先配置翻译服务';
    document.querySelector('#translate').onclick=()=>chrome.runtime.openOptionsPage();
  }else show(`${s.model} → ${s.target}`);
}catch(e){show('无法读取设置，请重新打开扩展。',true);}

document.querySelector('#floating').onclick=async()=>{
  try {
    if(!tab?.url || !/^https?:/.test(tab.url))throw new Error('请在普通网页中开启悬浮球。');
    const origin=new URL(tab.url).origin;
    const prepared=send({type:'PREPARE_FLOAT',origin,tabId:tab.id});
    const granted=await chrome.permissions.request({origins:[origin+'/*']});
    await prepared;
    if(!granted){show('未授权常驻；仍可点击“翻译当前网页”显示本页悬浮球。');return;}
    const result=await send({type:'FLOAT_SITE',origin,tabId:tab.id});
    if(!result.ok)throw new Error(result.error);
    show('悬浮球已开启，此网站刷新后也会出现。点击球打开面板，拖动可调整高度。');
  }catch(e){show(e.message,true);}
};
