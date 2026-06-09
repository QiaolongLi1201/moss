#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-attachments.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseAttachArgs,
  preparePromptAttachments,
  renderPendingAttachmentSummary,
} from '../dist/cli/attachments.js';
import { prepareClipboardAttachment, prepareClipboardImageAttachment } from '../dist/cli/clipboard-image.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-attachments-'));
try {
  const imagePath = path.join(tempDir, 'screen shot.png');
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const textPath = path.join(tempDir, 'notes.txt');
  fs.writeFileSync(textPath, 'line one\nline two\n', 'utf8');

  assert.deepEqual(
    parseAttachArgs(`"${imagePath}" ${textPath.replace(/ /g, '\\ ')}`),
    [imagePath, textPath],
  );
  assert.deepEqual(
    parseAttachArgs(String.raw`"C:\Users\dmoss\screen shot.png" C:\tmp\notes.txt ./plain\ name.png`),
    [
      String.raw`C:\Users\dmoss\screen shot.png`,
      String.raw`C:\tmp\notes.txt`,
      './plain name.png',
    ],
  );

  const result = preparePromptAttachments([imagePath, textPath], { cwd: tempDir });
  assert.equal(result.attachments.length, 2);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.blocks[0].type, 'text');
  assert.match(result.blocks[0].text, /\[Image #1: screen shot\.png\]/);
  assert.equal(result.blocks[1].type, 'image');
  assert.equal(result.blocks[1].mimeType, 'image/png');
  assert.equal(result.blocks[1].filename, 'screen shot.png');
  assert.equal(result.blocks[1].data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  assert.equal(result.blocks[2].type, 'text');
  assert.match(result.blocks[2].text, /\[File #2: notes\.txt\]/);
  assert.match(result.blocks[2].text, /line two/);
  assert.match(renderPendingAttachmentSummary(result.attachments), /Image #1/);
  assert.match(renderPendingAttachmentSummary(result.attachments), /File #2/);

  const fileUrlResult = preparePromptAttachments([pathToFileURL(imagePath).href], { cwd: tempDir, startIndex: 7 });
  assert.equal(fileUrlResult.attachments.length, 1);
  assert.equal(fileUrlResult.attachments[0].kind, 'image');
  assert.equal(fileUrlResult.attachments[0].index, 7);

  const unsupported = path.join(tempDir, 'archive.bin');
  fs.writeFileSync(unsupported, Buffer.from([0, 1, 2, 3]));
  const unsupportedResult = preparePromptAttachments([unsupported], { cwd: tempDir });
  assert.equal(unsupportedResult.attachments.length, 0);
  assert.match(unsupportedResult.warnings[0], /Unsupported attachment/);

  const runtimeDir = path.join(tempDir, 'runtime');
  const clipboardResult = await prepareClipboardImageAttachment({
    runtimeDir,
    cwd: tempDir,
    startIndex: 3,
    saveClipboardImage: async (destPath) => {
      assert.match(destPath, /clipboard-.*\.png$/);
      fs.writeFileSync(destPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    },
  });
  assert.equal(clipboardResult.attachments.length, 1);
  assert.equal(clipboardResult.attachments[0].kind, 'image');
  assert.equal(clipboardResult.attachments[0].index, 3);
  assert.equal(clipboardResult.blocks[0].type, 'text');
  assert.match(clipboardResult.blocks[0].text, /\[Image #3:/);

  const clipboardFileResult = await prepareClipboardAttachment({
    runtimeDir,
    cwd: tempDir,
    startIndex: 4,
    saveClipboardImage: async () => {
      throw new Error('clipboard does not contain an image');
    },
    readClipboardPaths: async () => [textPath],
  });
  assert.equal(clipboardFileResult.attachments.length, 1);
  assert.equal(clipboardFileResult.attachments[0].kind, 'file');
  assert.equal(clipboardFileResult.attachments[0].index, 4);
  assert.match(clipboardFileResult.blocks[0].text, /\[File #4: notes\.txt\]/);

  console.log('[PASS] CLI attachment preparation');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
