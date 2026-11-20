const status=document.querySelector('#status');
const send=message=>chrome.runtime.sendMessage(message);
let tab,siteEnabled=false;
const floating=document.querySelector('#floating');
function updateSiteButton(){floating.textContent=siteEnabled?'关闭划词入口':'开启划词入口';floating.setAttribute('aria-pressed',String(siteEnabled));}
function show(text,error=false){status.textContent=text;status.className='status'+(error?' error':'');}
document.querySelector('#settings').onclick=()=>chrome.runtime.openOptionsPage();
document.querySelector('#assistant').onclick=()=>{
  // Invoke immediately inside the click gesture; awaiting first loses Chrome's gesture.
  chrome.sidePanel.open(tab?.id?{tabId:tab.id}:{windowId:chrome.windows.WINDOW_ID_CURRENT})
    .then(()=>window.close()).catch(()=>show('侧栏暂时无法打开，请重新打开扩展后再试。',true));
};
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
  if(tab?.url && /^https?:/.test(tab.url)){
    const state=await send({type:'SITE_STATUS',origin:new URL(tab.url).origin});siteEnabled=!!state.enabled;updateSiteButton();
  }
  const result=await send({type:'GET_SETTINGS'});
  if(!result.ok)throw new Error(result.error);
  const s=result.settings;
  if(!s.apiKey&&!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(s.endpoint)){
    show('首次使用：先在设置中填写 API 地址、模型和密钥。');
    document.querySelector('#translate').textContent='先配置翻译服务';
    document.querySelector('#translate').onclick=()=>chrome.runtime.openOptionsPage();
  }else show(`${s.model} → ${s.target}`);
}catch(e){show('无法读取设置，请重新打开扩展。',true);}

floating.onclick=async()=>{
  try {
    if(!tab?.url || !/^https?:/.test(tab.url))throw new Error('请在普通网页中开启悬浮球。');
    const origin=new URL(tab.url).origin;
    if(siteEnabled){
      floating.disabled=true;
      const result=await send({type:'UNFLOAT_SITE',origin});if(!result.ok)throw new Error(result.error);
      siteEnabled=false;updateSiteButton();show('已关闭此网站的划词入口。');return;
    }
    const prepared=send({type:'PREPARE_FLOAT',origin,tabId:tab.id});
    const granted=await chrome.permissions.request({origins:[origin+'/*']});
    const preparation=await prepared;if(!preparation.ok)throw new Error(preparation.error);
    if(!granted){show('未授权常驻；仍可点击“翻译当前网页”显示本页悬浮球。');return;}
    const result=await send({type:'FLOAT_SITE',origin,tabId:tab.id});
    if(!result.ok)throw new Error(result.error);
    siteEnabled=true;updateSiteButton();
    show('已为此网站开启划词入口。');
  }catch(e){show(e.message,true);}finally{floating.disabled=false;}
};
