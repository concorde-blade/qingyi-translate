import test from 'node:test';
import assert from 'node:assert/strict';
import {readLocalDocument, readPDFBytes, DOCUMENT_LIMITS} from '../src/document-reader.js';

const file = (name, content, type = '') => new File([content], name, {type});
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('reads supported text formats as plain text and normalizes newlines', async () => {
  for (const [name, kind, content] of [
    ['notes.TXT', 'text', 'line one\r\nline two\rline three'],
    ['output.log', 'text', 'Log entries remain plain text.'],
    ['notes.md', 'markdown', '# 标题\n\n**保留标记**'],
    ['notes.markdown', 'markdown', '# Longer suffix'],
    ['data.csv', 'csv', 'name,formula\nAlice,=1+1'],
    ['data.json', 'json', '{"execute":"<script>alert(1)</script>"}'],
  ]) {
    const result = await readLocalDocument(file(name, content));
    assert.equal(result.title, name); assert.equal(result.kind, kind);
    assert.equal(result.text, content.replace(/\r\n?/g, '\n')); assert.equal(result.truncated, false);
  }
  assert.equal((await readLocalDocument(file('untitled', 'Text', 'text/plain'))).kind, 'text');
});

test('supports UTF-8 and BOM-tagged UTF-16, including non-Latin text', async () => {
  const text = '中文 café 😀';
  assert.equal((await readLocalDocument(file('utf8.txt', new Uint8Array([239,187,191,...new TextEncoder().encode(text)])))).text, text);
  const le = new Uint8Array(2 + text.length * 2), be = new Uint8Array(le.length);
  le.set([255,254]); be.set([254,255]);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    le[2+index*2] = code & 255; le[3+index*2] = code >> 8;
    be[2+index*2] = code >> 8; be[3+index*2] = code & 255;
  }
  for (const bytes of [le, be]) assert.equal((await readLocalDocument(file('unicode.txt', bytes))).text, text);
});

test('clips text to the shared budget without splitting surrogate pairs', async () => {
  const exact = await readLocalDocument(file('exact.txt', 'a'.repeat(DOCUMENT_LIMITS.chars)));
  assert.equal(exact.text.length, DOCUMENT_LIMITS.chars); assert.equal(exact.truncated, false);
  const clipped = await readLocalDocument(file('long.txt', 'a'.repeat(DOCUMENT_LIMITS.chars - 1) + '😀tail'));
  assert.equal(clipped.text.length, DOCUMENT_LIMITS.chars - 1); assert.equal(clipped.truncated, true);
  assert.equal(clipped.text, 'a'.repeat(DOCUMENT_LIMITS.chars - 1));
});

test('rejects unsupported, empty, binary, invalid encoding and oversized files', async () => {
  await rejectsCode(readLocalDocument(null), 'DOCUMENT_TYPE');
  await rejectsCode(readLocalDocument(file('document.docx', 'not supported')), 'DOCUMENT_TYPE');
  await rejectsCode(readLocalDocument(file('image.png', 'disguised', 'text/plain')), 'DOCUMENT_TYPE');
  await rejectsCode(readLocalDocument(file('empty.txt', '')), 'DOCUMENT_EMPTY');
  await rejectsCode(readLocalDocument(file('spaces.txt', ' \r\n\t')), 'DOCUMENT_EMPTY');
  await rejectsCode(readLocalDocument(file('binary.txt', 'hello\0world')), 'DOCUMENT_TYPE');
  await rejectsCode(readLocalDocument(file('invalid.txt', new Uint8Array([0xc3,0x28]))), 'TEXT_ENCODING');
  let read = false;
  await rejectsCode(readLocalDocument({name:'large.pdf', size:DOCUMENT_LIMITS.bytes + 1, arrayBuffer:async () => {read = true;}}), 'DOCUMENT_TOO_LARGE');
  assert.equal(read, false);
});

test('cancels before reading and while awaiting local file bytes', async () => {
  const before = new AbortController(); before.abort();
  await rejectsCode(readLocalDocument(file('notes.txt', 'hello'), {signal:before.signal}), 'CANCELLED');
  const pending = new AbortController();
  const reading = readLocalDocument({name:'notes.txt', size:1, arrayBuffer:() => new Promise(() => {})}, {signal:pending.signal});
  pending.abort(); await rejectsCode(reading, 'CANCELLED');
});

test('validates PDF input before loading its browser worker', async () => {
  await rejectsCode(readPDFBytes('not bytes'), 'PDF_INVALID');
  await rejectsCode(readPDFBytes(new Uint8Array()), 'DOCUMENT_EMPTY');
  await rejectsCode(readPDFBytes(new Uint8Array(DOCUMENT_LIMITS.bytes + 1)), 'DOCUMENT_TOO_LARGE');
  await rejectsCode(readPDFBytes(new TextEncoder().encode('<html>Error</html>')), 'PDF_INVALID');
  const controller = new AbortController(); controller.abort();
  await rejectsCode(readPDFBytes(new TextEncoder().encode('%PDF-1.4'), {signal:controller.signal}), 'CANCELLED');
});
