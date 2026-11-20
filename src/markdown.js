import MarkdownIt from './vendor/markdown-it/markdown-it.mjs';
import {protectMath,restoreMath} from './math-renderer.js';

// Standard Markdown, with raw HTML and remote images disabled for model output.
const markdown=new MarkdownIt({html:false,breaks:true,linkify:false,typographer:false});
markdown.disable('image');
markdown.validateLink=url=>{try{return ['http:','https:'].includes(new URL(url).protocol);}catch{return false;}};
markdown.renderer.rules.link_open=(tokens,index,options,env,self)=>{
  tokens[index].attrSet('target','_blank');tokens[index].attrSet('rel','noopener noreferrer');
  return self.renderToken(tokens,index,options);
};
markdown.renderer.rules.table_open=()=>'<div class="table-wrap"><table>\n';
markdown.renderer.rules.table_close=()=>'</table></div>\n';

export function renderMarkdown(text,target) {
  const source=String(text||'');
  try {
  const protectedText=protectMath(source.replace(/\r\n?/g,'\n'));
  const template=document.createElement('template');
  // Markdown-It escapes source HTML and validates link destinations before output.
  template.innerHTML=markdown.render(protectedText.text);
  restoreMath(template.content,protectedText);
  target.replaceChildren(template.content);
  } catch { target.textContent=source; }
}
