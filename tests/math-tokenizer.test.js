import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from '../src/vendor/markdown-it/markdown-it.mjs';
import {protectMath} from '../src/math-renderer.js';

const markdown=new MarkdownIt({html:false});
const complete=result=>result.formulas.filter(formula=>!formula.literal);
const quoteRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

test('all delimiters preserve TeX before Markdown-sensitive characters and line breaks',()=>{
  const text=String.raw`Inline $x_i * y$ and \(a_b\).

$$\begin{aligned}a&=b\\c&=d\end{aligned}$$

\[x|y

z\]`;
  const result=protectMath(text),formulas=complete(result);
  assert.equal(formulas.length,4);assert.deepEqual(formulas.map(item=>item.display),[false,false,true,true]);
  assert.equal(formulas[0].tex,'x_i * y');assert.equal(formulas[1].tex,'a_b');assert.ok(formulas[3].tex.includes('\n\n'));
});

test('escaped dollars, currency amounts and literal backslash delimiters stay prose',()=>{
  for(const text of [String.raw`Costs $5, $10 and \$20.`,String.raw`Escaped \$x\$`,String.raw`Literal \\(x\\)`])assert.equal(complete(protectMath(text)).length,0,text);
  const result=protectMath(String.raw`$\text{cost \$5}+x$`);
  assert.equal(complete(result).length,1);assert.equal(complete(result)[0].tex,String.raw`\text{cost \$5}+x`);
});

test('inline code and fenced code protect their contents while following formulas render',()=>{
  const cases=[
    'Use ``a ` $x$`` then $y$.',
    '```tex\n$x$\n```\n\n$y$',
    '~~~~\n$x$\n~~~\n$$z$$\n~~~~\n\n$y$',
    '> ```tex\n> $x$\n> ```\n\n$y$'
  ];
  for(const text of cases)assert.deepEqual(complete(protectMath(text)).map(item=>item.tex),['y'],text);
});

test('indented code with an unmatched math opener does not swallow later prose',()=>{
  for(const indent of ['    ','\t']) {
    const text=indent+'$$\n'+indent+'code $x$\n\nOutside $y$.';
    const result=protectMath(text);
    assert.deepEqual(complete(result).map(item=>item.tex),['y']);
    assert.ok(result.text.includes('Outside '));
  }
});

test('unclosed streamed mathematics retains its exact original source',()=>{
  for(const text of [String.raw`$a_i + b`,String.raw`\[\frac{a_b}{c}`]) {
    const result=protectMath(text);
    assert.equal(result.formulas.length,1);assert.equal(result.formulas[0].literal,true);assert.equal(result.formulas[0].raw,text);
  }
  const completeResult=protectMath(String.raw`\[\frac{a_b}{c}\]`);
  assert.equal(complete(completeResult).length,1);
});

test('inline and bare link destinations do not acquire formula markers',()=>{
  const result=protectMath('[label $x$](https://example.com/$path$ "title $z$") https://example.com/$value$');
  assert.deepEqual(complete(result).map(item=>item.tex),['x']);
  const rendered=markdown.render(result.text);
  assert.ok(rendered.includes('title="title $z$"'));assert.ok(rendered.includes('href="https://example.com/$path$"'));
});

test('reference definitions and reference IDs stay intact and do not leak markers into attributes',()=>{
  const withTitle=protectMath('[read][ref]\n\n[ref]: https://example.com "title $x$"');
  assert.equal(withTitle.formulas.length,0);
  assert.ok(markdown.render(withTitle.text).includes('title="title $x$"'));
  const withMathID=protectMath('[read][$ref$]\n\n[$ref$]: https://example.com');
  assert.equal(withMathID.formulas.length,0);assert.ok(markdown.render(withMathID.text).includes('href="https://example.com"'));
});

test('multiline and blockquoted reference metadata never acquire formula markers',()=>{
  const cases=[
    '[read][ref]\n\n[ref]:\n  https://example.com\n  "title $x$"',
    '[read][ref]\n\n[ref]: https://example.com\n  "title $x$\n  and $y$"',
    '[read][ref]\n\n> [ref]: https://example.com "title $x$"'
  ];
  for(const text of cases) {
    const result=protectMath(text),rendered=markdown.render(result.text);
    assert.equal(result.formulas.length,0,text);
    assert.ok(rendered.includes('href="https://example.com"'),text);
    assert.ok(rendered.includes('title="title $x$'),text);
    assert.ok(!rendered.includes(result.marker),text);
  }
});

test('quoted parentheses in link titles do not terminate destination protection early',()=>{
  const result=protectMath('[label $x$](https://example.com "title ) $literal$")');
  assert.deepEqual(complete(result).map(item=>item.tex),['x']);
  assert.ok(markdown.render(result.text).includes('title="title ) $literal$"'));
});

test('escaped backticks are prose rather than inline-code fences',()=>{
  const result=protectMath('\\` literal $x$ \\`');
  assert.deepEqual(complete(result).map(item=>item.tex),['x']);
});

test('source text and HTML entities cannot forge the current render marker',()=>{
  for(const prefix of ['\uE000MX999\uE001','&#xE000;MX999&#xE001;','&#57344;MX0&#57345;']) {
    const result=protectMath(prefix+' $x$');
    const rendered=markdown.render(result.text);
    const indexes=[...rendered.matchAll(new RegExp(quoteRegex(result.marker)+'(\\d+)\uE001','g'))].map(match=>Number(match[1]));
    assert.deepEqual(indexes,[0],prefix);
  }
});
