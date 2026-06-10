#!/usr/bin/env node
/**
 * Attachments must not claim "attached" for images that are empty or not
 * actually images (renamed/corrupt files) — same verified-outcome class as
 * /connect. Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preparePromptAttachments, detectImageMime } from '../dist/cli/attachments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-attach-'));
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

// detectImageMime signatures
assert.equal(detectImageMime(PNG), 'image/png');
assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
assert.equal(detectImageMime(Buffer.from('GIF89a......')), 'image/gif');
assert.equal(detectImageMime(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
assert.equal(detectImageMime(Buffer.from('not an image at all')), null);
assert.equal(detectImageMime(Buffer.alloc(0)), null);

// Zero-byte image: warned, NOT attached
{
  const p = path.join(tmp, 'empty.png');
  fs.writeFileSync(p, '');
  const result = preparePromptAttachments([p], { cwd: tmp });
  assert.equal(result.attachments.length, 0, 'zero-byte image must not attach');
  assert.match(result.warnings.join('\n'), /empty \(0 bytes\)/);
}

// Text file renamed to .png: warned, NOT attached
{
  const p = path.join(tmp, 'fake.png');
  fs.writeFileSync(p, 'hello I am not a png');
  const result = preparePromptAttachments([p], { cwd: tmp });
  assert.equal(result.attachments.length, 0, 'invalid signature must not attach');
  assert.match(result.warnings.join('\n'), /not a valid image signature/);
}

// Valid PNG: attached with verified mime
{
  const p = path.join(tmp, 'real.png');
  fs.writeFileSync(p, PNG);
  const result = preparePromptAttachments([p], { cwd: tmp });
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].mimeType, 'image/png');
  assert.equal(result.warnings.length, 0);
  const imageBlock = result.blocks.find((b) => b.type === 'image');
  assert.ok(imageBlock && imageBlock.data.length > 0, 'image block must carry non-empty data');
}

// JPEG bytes in a .png file: detected mime wins over extension
{
  const p = path.join(tmp, 'mislabeled.png');
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]));
  const result = preparePromptAttachments([p], { cwd: tmp });
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].mimeType, 'image/jpeg', 'real signature wins over extension');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[PASS] attachment image validation: empty/corrupt images rejected, real ones verified');
