// Conservative local routing only. Documents, page bodies and assistant replies
// are deliberately absent from this interface and never become search queries.
const normalize=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
const sourceOnly=/(?:仅|只|只能|完全|严格)\s*(?:需|需要|使用|基于|依据|根据|参考|看|阅读|分析|结合|用)?\s*(?:我(?:提供|上传|给出|附加)的?|所附|上传的?|现有|以上|上述|下列|这(?:份|篇|个|些)|该|附加的?)?\s*(?:文件|附件|资料|文档|论文|网页|原文|文本|材料|内容|对话)|\b(?:only|solely|exclusively)\s+(?:(?:use|using|based on|rely on|from|the|my|these|this|provided|attached|uploaded|current|previous)\s+)*(?:files?|documents?|attachments?|pages?|text|excerpts?|material|conversation)\b/gi;
function avoidsSearch(text) {
  if(/(?:不要|无需|不用|不必|不需要|禁止|别|避免|不想|不允许|勿)\s*(?:再|进行|使用)?\s*(?:任何|网络|在线|实时)?\s*(?:联网|上网|搜索|检索|查找|查资料|浏览网络)|不联网|不上网|不搜索|\b(?:do not|don't|dont|no|without|avoid|never|skip|disable)\s+(?:use\s+)?(?:any\s+)?(?:(?:web|online|internet)\s+)?(?:search(?:ing)?|brows(?:e|ing)|lookups?|internet|network)\b/i.test(text))return true;
  for(const match of text.matchAll(sourceOnly)) {
    const before=text.slice(Math.max(0,match.index-12),match.index);
    if(!/(?:不要|并非|不是|不应|不能|不仅|不只|not)\s*$/i.test(before))return true;
  }
  return false;
}
function explicitlySearches(text) {
  const plain=text.replace(/(?:二分|深度优先|广度优先|启发式|本地|文件|字符串|代码)搜索(?:算法|函数|功能)?/g,'');
  return /联网|上网|搜索(?!算法|函数|功能|按钮|框|引擎)|检索(?!算法|函数)|查找(?:资料|来源|文献|论文|信息)|查一下|查查|查证|核实|(?:^|[。！？,，;；])\s*(?:please\s+)?search\b|\b(?:search\s+(?:for|online|the web)|web search|look\s+up|browse\s+(?:the\s+)?web|google|find\s+(?:online|sources|references))\b/i.test(plain);
}
function shortFollowup(text) {
  if(text.length>80)return false;
  const compact=text.replace(/[。.!！?？，,\s]/g,'');
  return /^(?:(?:请|再|麻烦|帮我|给我|能否|可以){0,3})(?:继续|接着|然后|展开(?:说说|说明|解释)?|(?:更|再)?(?:详细|具体|深入)(?:一点|一些|些|点)?|(?:讲|说|解释)(?:得)?(?:更|再)?(?:详细|具体|深入)(?:一点|一些|些|点)?|举(?:一)?个例子|解释一下|为什么|怎么理解|什么意思)(?:呢|吧|吗|好吗)?$/.test(compact) ||
    /^(?:please\s+)?(?:continue|go on|keep going|tell me more|more details?|explain more|elaborate|expand(?: on (?:it|that|this))?|give (?:me )?(?:an? )?example|what else|why|how so|and then)[.!?\s]*$/i.test(text);
}
const greeting=text=>/^(?:(?:你好|您好|嗨|哈喽|早上好|晚上好|谢谢|感谢|再见|早安|晚安|你好吗|在吗|hello|hi|hey|thanks?|thank you|good (?:morning|evening|night)|how are you)[，,。.!！?？\s]*)+$/i.test(text);
const composition=text=>/(?:^|[。！？,，;；])\s*(?:(?:请|帮我|麻烦|给我)\s*)*(?:写|创作|起草|改写|润色|翻译|续写|扩写|缩写|校对|排版|重构|调试|修复|编写|实现|生成)|润色|改写|翻译|起草|代码|函数|编程|调试|报错|堆栈|正则|二分搜索|\b(?:write|draft|rewrite|proofread|translate|compose|polish|refactor|debug|implement|coding|code|function|script|regex|stack trace|traceback)\b/i.test(text);
const factual=text=>/是什么|什么是|为什么|是谁|哪一年|何时|什么时候|在哪里|多少|有何区别|有什么区别|原理|定义|实验|论文|文献|研究|证据|结论|进展|数据|统计|历史|起源|诺贝尔|量子|物理|化学|生物|天文|数学|经济|政策|法规|新闻|价格|汇率|天气|对比|比较|最新|实时|\b(?:what|who|when|where|why|explain|define|definition|theorem|experiment|research|stud(?:y|ies)|papers?|evidence|sources?|citations?|compare|difference|latest|current|recent|news|price|weather)\b/i.test(text);

export function buildSearchQuery(text,messages=[]) {
  const question=normalize(text);
  if(!question)return '';
  const refersBack=/(?:它|这(?:个|项|些|种|篇|份)|该(?:项|研究|理论|论文)|上述|刚才|前面)|\b(?:it|this|that|these|those|previous|above)\b/i.test(question);
  if(refersBack && question.length<240 && Array.isArray(messages)) {
    for(const message of messages.slice(-16).reverse()) {
      if(message?.role!=='user')continue;
      const previous=normalize(message.content);
      // Long pasted material is never mined for search terms. Only a prior short
      // factual question can resolve a follow-up's topic; the current question wins.
      if(!previous || previous===question || previous.length>240 || shortFollowup(previous) || greeting(previous) || composition(previous) || avoidsSearch(previous) || !factual(previous))continue;
      return `${previous.slice(0,Math.min(180,299-question.length))} ${question}`;
    }
  }
  return question.slice(0,300);
}

export function decideWebSearch({text,enabled=false,mode='chat',hasDocuments=false,hasPage=false,hasURLs=false,messages=[]}={}) {
  const question=normalize(text);
  const answer=(search,explicit,reason)=>({search,explicit,reason,query:search?buildSearchQuery(question,messages):''});
  if(!question)return answer(false,false,'empty');
  if(avoidsSearch(question))return answer(false,false,'user-opt-out');
  const explicit=explicitlySearches(question);
  if(!enabled)return answer(false,explicit,'disabled');
  if(explicit)return answer(true,true,'explicit');
  if(shortFollowup(question))return answer(false,false,'follow-up');
  if(greeting(question))return answer(false,false,'greeting');
  if(['rewrite','translate'].includes(mode) || composition(question))return answer(false,false,'composition');
  if(hasDocuments || hasPage || hasURLs)return answer(false,false,'provided-sources');
  if(mode==='research' || factual(question))return answer(true,false,'factual-question');
  return answer(false,false,'conversation');
}
