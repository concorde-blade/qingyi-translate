// Self-contained so Chrome can serialize this function into the active page.
// Called only after the user explicitly chooses to attach or summarize a page.
export function extractPageContext() {
  const max = 24000;
  const blocked = 'script,style,noscript,template,iframe,object,embed,input,textarea,select,button,form,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[aria-hidden="true"],[data-qingyi]';
  const chrome = 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="dialog"],[role="menu"],[role="toolbar"]';
  const visible = element => {
    if (element.closest(blocked)) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return getComputedStyle(element).display === 'contents' || element.getClientRects().length > 0;
  };
  const root = [...document.querySelectorAll('article,main,[role="main"]')].find(visible) || document.body;
  let text = '', truncated = false;
  const append = value => {
    if (!value) return;
    const remaining = max - text.length;
    if (value.length > remaining) truncated = true;
    text += value.slice(0, Math.max(0, remaining));
  };
  function read(node) {
    if (text.length >= max) {truncated = true; return;}
    if (node.nodeType === Node.TEXT_NODE) {append(node.data.replace(/[\t\r\n ]+/g, ' ')); return;}
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(blocked + ',' + chrome) || !visible(node)) return;
    const formula = node.matches('math,mjx-container,.katex') && (node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || node.getAttribute('alttext') || node.getAttribute('aria-label'));
    if (formula) {append(' $' + formula + '$ '); return;}
    const block = /^(P|DIV|SECTION|ARTICLE|H[1-6]|LI|BLOCKQUOTE|PRE|TR|BR)$/.test(node.tagName);
    if (block && text && !text.endsWith('\n')) append('\n');
    for (const child of node.childNodes) {read(child); if (text.length >= max) break;}
    if (block && text && !text.endsWith('\n')) append('\n');
  }
  if (root) read(root);
  // Read only the selected visible text nodes; never accept raw selection.toString()
  // across editors, hidden descendants, or extension UI.
  let selection = '';
  const selected = getSelection();
  if (selected?.rangeCount && !selected.isCollapsed) {
    const range = selected.getRangeAt(0), common = range.commonAncestorContainer;
    const start = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
    if (start && !start.closest(blocked)) {
      const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && selection.length < 12000) {
        if (!range.intersectsNode(node) || !visible(node.parentElement)) continue;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.length;
        selection += node.data.slice(from, to);
      }
      selection = selection.trim().slice(0, 12000);
    }
  }
  // Queries and fragments may contain account tokens or tracking parameters.
  const url = new URL(location.href); url.search = ''; url.hash = ''; url.username = ''; url.password = '';
  return {title: document.title.slice(0, 240), url: url.href, text: text.trim(), selection, truncated};
}
