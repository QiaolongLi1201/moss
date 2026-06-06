#!/usr/bin/env node
/**
 * Test: web_fetch SPA-shell honesty note.
 *
 * A JS single-page-app returns an HTML shell with no readable body; web_fetch
 * cannot run JS, so it must tell the model the content was NOT retrieved instead
 * of letting an empty shell pass as the page (a confabulation hazard).
 */
import assert from 'node:assert/strict';
import { detectSpaShellNote } from '../dist/tools/web-fetch.js';

const filler = '<meta>'.repeat(200); // pad past the 600-byte size gate

// 1) Classic React/Docusaurus SPA shell: script bundle + #root, empty body.
{
  const html = `<!DOCTYPE html><html><head>${filler}<script src="/assets/main.123.js"></script></head><body><div id="root"></div></body></html>`;
  const note = detectSpaShellNote(html, '   ');
  assert.ok(note, 'a content-less SPA shell should produce a note');
  assert.match(note, /single-page app|client-side-rendered/i);
  assert.match(note, /raw source|source repo|API/i, 'note should point to a real data source');
}

// 2) __NEXT_DATA__ style SPA, also flagged.
{
  const html = `<html><head>${filler}</head><body><div id="__next"></div><script>window.__NEXT_DATA__={}</script></body></html>`;
  assert.ok(detectSpaShellNote(html, ''), 'Next.js shell should be flagged');
}

// 3) A real article with plenty of readable text -> NO note (don't cry wolf).
{
  const html = `<html><body><article><script>x</script><div id="root">${'Real documentation content about the RDK X5 40-pin header and BPU. '.repeat(20)}</div></article></body></html>`;
  const extracted = 'Real documentation content about the RDK X5 40-pin header and BPU. '.repeat(20);
  assert.equal(detectSpaShellNote(html, extracted), null, 'a content-rich page must not be flagged as an SPA');
}

// 4) Tiny page (below the size gate) -> NO note.
{
  assert.equal(detectSpaShellNote('<html><body><div id="root"></div></body></html>', ''), null, 'a tiny shell is not treated as a content SPA');
}

// 5) Substantial HTML with a script but NO SPA root marker -> NO note (conservative).
{
  const html = `<html><head>${filler}<script>console.log(1)</script></head><body><p>hi</p></body></html>`;
  assert.equal(detectSpaShellNote(html, 'hi'), null, 'plain page with a script but no SPA mount must not be flagged');
}

console.log('[PASS] web_fetch SPA-shell honesty note');
