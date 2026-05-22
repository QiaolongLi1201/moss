#!/usr/bin/env node
/**
 * Self-test for TeachingAnnotationCollector.
 *
 * Run:
 *   npm run build -w @dmoss/teaching
 *   node packages/dmoss-teaching/test/teaching-annotation-collector.spec.mjs
 */

import assert from 'node:assert/strict';
import { TeachingAnnotationCollector, digestStudioToolCall } from '../dist/index.js';

// ── Constructor ──

{
  // Accepts all three valid teaching depth values
  const off = new TeachingAnnotationCollector('off');
  const concise = new TeachingAnnotationCollector('concise');
  const detailed = new TeachingAnnotationCollector('detailed');
  // No errors thrown means construction succeeded
  assert.ok(off);
  assert.ok(concise);
  assert.ok(detailed);
}

// ── markEligible ──

{
  // "detailed" depth: all tools are eligible (mutation or not)
  const collector = new TeachingAnnotationCollector('detailed');
  collector.markEligible('read_tool', false);
  collector.markEligible('write_tool', true);
  // recordToolStart is needed so assembleTeachingMeta doesn't return undefined early
  collector.recordToolStart('read_tool', {});
  collector.observe({
    v: 1,
    argsDigest: digestStudioToolCall('read_tool', {}),
    phase: 'pre',
    patch: { why: 'test' },
  });
  const meta = collector.assembleTeachingMeta();
  assert.ok(meta?.eligibleToolNames?.includes('read_tool'), 'detailed: non-mutation should be eligible');
  assert.ok(meta?.eligibleToolNames?.includes('write_tool'), 'detailed: mutation should be eligible');
}

{
  // "concise" depth: only mutation tools are eligible
  const collector = new TeachingAnnotationCollector('concise');
  collector.markEligible('read_tool', false);
  collector.markEligible('write_tool', true);
  collector.recordToolStart('write_tool', {});
  collector.observe({
    v: 1,
    argsDigest: digestStudioToolCall('write_tool', {}),
    phase: 'pre',
    patch: { why: 'test' },
  });
  const meta = collector.assembleTeachingMeta();
  assert.ok(!meta?.eligibleToolNames?.includes('read_tool'), 'concise: non-mutation should NOT be eligible');
  assert.ok(meta?.eligibleToolNames?.includes('write_tool'), 'concise: mutation should be eligible');
}

{
  // "off" depth: no tools are eligible
  const collector = new TeachingAnnotationCollector('off');
  collector.markEligible('read_tool', false);
  collector.markEligible('write_tool', true);
  collector.recordToolStart('read_tool', {});
  collector.observe({
    v: 1,
    argsDigest: digestStudioToolCall('read_tool', {}),
    phase: 'pre',
    patch: { why: 'test' },
  });
  const meta = collector.assembleTeachingMeta();
  assert.ok(!meta?.eligibleToolNames?.includes('read_tool'), 'off: non-mutation should NOT be eligible');
  assert.ok(!meta?.eligibleToolNames?.includes('write_tool'), 'off: mutation should NOT be eligible');
}

// ── recordToolStart / recordToolResult ──

{
  // recordToolStart populates the digest→toolName map via digestStudioToolCall
  const collector = new TeachingAnnotationCollector('detailed');
  collector.recordToolStart('shell_exec', { cmd: 'echo hello' });
  // The internal map is not directly accessible, but we can verify via observe+assembleTeachingMeta
  const digest = digestStudioToolCall('shell_exec', { cmd: 'echo hello' });
  collector.observe({
    v: 1,
    argsDigest: digest,
    phase: 'pre',
    patch: { why: 'testing', concept: 'basic' },
  });
  const meta = collector.assembleTeachingMeta();
  assert.equal(meta?.preAnnotations?.[0]?.toolName, 'shell_exec');
}

{
  // recordToolResult populates the callId→toolName map
  const collector = new TeachingAnnotationCollector('detailed');
  collector.recordToolResult('call-123', 'write_file');
  collector.observe({
    v: 1,
    toolCallId: 'call-123',
    phase: 'post',
    patch: { verifyHint: 'check it', confidence: 'high' },
  });
  const meta = collector.assembleTeachingMeta();
  assert.equal(meta?.postAnnotations?.[0]?.toolName, 'write_file');
}

// ── observe ──

{
  // observe stores pre-phase annotations with argsDigest
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    argsDigest: 'abc123',
    phase: 'pre',
    patch: { why: 'run ls to see files', concept: 'listing directory' },
  });
  const meta = collector.assembleTeachingMeta();
  assert.equal(meta?.preAnnotations?.length, 1);
  assert.equal(meta?.preAnnotations?.[0]?.argsDigest, 'abc123');
  assert.equal(meta?.preAnnotations?.[0]?.why, 'run ls to see files');
}

{
  // observe stores post-phase annotations with toolCallId
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    toolCallId: 'call-456',
    phase: 'post',
    patch: {
      verifyHint: 'check stdout',
      confidence: 'medium',
      confidenceReason: 'output looks clean',
      nextStepIfFails: 'retry',
      rollbackSupported: true,
      rollbackHint: 'git checkout',
    },
  });
  const meta = collector.assembleTeachingMeta();
  assert.equal(meta?.postAnnotations?.length, 1);
  const ann = meta?.postAnnotations?.[0];
  assert.equal(ann?.toolCallId, 'call-456');
  assert.equal(ann?.verifyHint, 'check stdout');
  assert.equal(ann?.confidence, 'medium');
  assert.equal(ann?.confidenceReason, 'output looks clean');
  assert.equal(ann?.nextStepIfFails, 'retry');
  assert.equal(ann?.rollbackSupported, true);
  assert.equal(ann?.rollbackHint, 'git checkout');
}

{
  // observe ignores dry_run_summary phase
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    phase: 'dry_run_summary',
    patch: { device: 'board', scope: 'test' },
  });
  const meta = collector.assembleTeachingMeta();
  // dry_run_summary is skipped, no annotations collected → returns undefined
  assert.equal(meta, undefined, 'dry_run_summary should not produce annotations');
}

{
  // observe ignores annotations with skip: true
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    argsDigest: 'xyz',
    phase: 'pre',
    patch: { skip: true },
  });
  const meta = collector.assembleTeachingMeta();
  // skip:true annotations are not stored → assembleTeachingMeta returns undefined
  assert.equal(meta, undefined, 'skip:true should not produce annotations');
}

{
  // observe ignores annotations with missing patch
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    argsDigest: 'xyz',
    phase: 'pre',
  });
  const meta = collector.assembleTeachingMeta();
  assert.equal(meta, undefined, 'missing patch should result in no annotations and undefined meta');
}

// ── assembleTeachingMeta: pre annotation field extraction ──

{
  // Pre annotation extracts why, concept, pitfalls correctly
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    argsDigest: 'd1',
    phase: 'pre',
    patch: {
      why: 'do the thing',
      concept: 'it works',
      pitfalls: ['watch out', 'be careful', 123, null, 'third'],
    },
  });
  const meta = collector.assembleTeachingMeta();
  const ann = meta?.preAnnotations?.[0];
  assert.equal(ann?.why, 'do the thing');
  assert.equal(ann?.concept, 'it works');
  // pitfalls should filter to only strings
  assert.ok(Array.isArray(ann?.pitfalls));
  assert.equal(ann?.pitfalls?.length, 3);
  assert.equal(ann?.pitfalls?.[0], 'watch out');
  assert.equal(ann?.pitfalls?.[1], 'be careful');
  assert.equal(ann?.pitfalls?.[2], 'third');
}

// ── assembleTeachingMeta: post annotation field extraction ──

{
  // Post annotation extracts failureCard correctly
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    toolCallId: 'call-789',
    phase: 'post',
    patch: {
      verifyHint: 'look at logs',
      confidence: 'low',
      failureCard: {
        cause: 'network timeout',
        actions: ['retry', 'check connection'],
        stopWhen: '3 failures',
        rollbackAvailable: true,
      },
    },
  });
  const meta = collector.assembleTeachingMeta();
  const ann = meta?.postAnnotations?.[0];
  assert.ok(ann?.failureCard);
  assert.equal(ann?.failureCard?.cause, 'network timeout');
  assert.deepEqual(ann?.failureCard?.actions, ['retry', 'check connection']);
  assert.equal(ann?.failureCard?.stopWhen, '3 failures');
  assert.equal(ann?.failureCard?.rollbackAvailable, true);
}

{
  // Post annotation ignores non-object failureCard
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    toolCallId: 'call-abc',
    phase: 'post',
    patch: {
      verifyHint: 'hint',
      failureCard: 'not-an-object',
    },
  });
  const meta = collector.assembleTeachingMeta();
  assert.equal(meta?.postAnnotations?.[0]?.failureCard, undefined);
}

// ── assembleTeachingMeta: return value ──

{
  // Returns undefined when no annotations and no tool starts recorded
  const collector = new TeachingAnnotationCollector('detailed');
  assert.equal(collector.assembleTeachingMeta(), undefined);
}

{
  // Returns undefined when only dry_run_summary was observed (ignored)
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    phase: 'dry_run_summary',
    patch: { device: 'x' },
  });
  assert.equal(collector.assembleTeachingMeta(), undefined);
}

{
  // Returns undefined when only skipped annotations were observed
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    phase: 'pre',
    argsDigest: 'x',
    patch: { skip: true },
  });
  assert.equal(collector.assembleTeachingMeta(), undefined);
}

{
  // Returns meta object when there are valid annotations
  const collector = new TeachingAnnotationCollector('detailed');
  collector.observe({
    v: 1,
    argsDigest: 'd1',
    phase: 'pre',
    patch: { why: 'test' },
  });
  const meta = collector.assembleTeachingMeta();
  assert.ok(meta);
  assert.equal(meta?.preAnnotations?.length, 1);
}

// ── assembleTeachingMeta: annotatedToolNames and coverage ──

{
  // annotatedToolNames contains tools that were actually annotated
  const collector = new TeachingAnnotationCollector('detailed');
  collector.recordToolStart('tool_a', { x: 1 });
  collector.recordToolStart('tool_b', { y: 2 });

  const digestA = digestStudioToolCall('tool_a', { x: 1 });
  collector.observe({
    v: 1,
    argsDigest: digestA,
    phase: 'pre',
    patch: { why: 'testing tool_a' },
  });

  collector.markEligible('tool_a', false);
  collector.markEligible('tool_b', false);

  const meta = collector.assembleTeachingMeta();
  assert.ok(meta?.annotatedToolNames?.includes('tool_a'));
  assert.ok(!meta?.annotatedToolNames?.includes('tool_b'));
}

{
  // annotationCoverage is ratio of annotated tools that are in eligible set
  const collector = new TeachingAnnotationCollector('detailed');
  collector.markEligible('tool_a', false);
  collector.markEligible('tool_b', false);
  collector.markEligible('tool_c', false);

  // Only annotate tool_a
  collector.recordToolStart('tool_a', { x: 1 });
  const digestA = digestStudioToolCall('tool_a', { x: 1 });
  collector.observe({
    v: 1,
    argsDigest: digestA,
    phase: 'pre',
    patch: { why: 'only tool_a' },
  });

  const meta = collector.assembleTeachingMeta();
  // 1 annotated out of 3 eligible → coverage = 1/3
  assert.ok(Math.abs((meta?.annotationCoverage ?? 0) - 1 / 3) < 0.001,
    `annotationCoverage should be ~0.333, got ${meta?.annotationCoverage}`);
}

{
  // annotationCoverage = 1 when eligible is empty but annotations exist with resolved toolName
  const collector = new TeachingAnnotationCollector('detailed');
  // Must record tool start so the argsDigest maps to a toolName → annotatedToolNames is non-empty
  collector.recordToolStart('tool_x', { a: 1 });
  const d = digestStudioToolCall('tool_x', { a: 1 });
  collector.observe({
    v: 1,
    argsDigest: d,
    phase: 'pre',
    patch: { why: 'no eligible tools' },
  });
  const meta = collector.assembleTeachingMeta();
  // eligible is empty, but annotated has entries → coverage = 1
  assert.equal(meta?.annotationCoverage, 1, 'coverage should be 1 when eligible is empty but annotations exist');
}

{
  // eligibleToolNames is populated from markEligible calls
  const collector = new TeachingAnnotationCollector('detailed');
  collector.markEligible('alpha', false);
  collector.markEligible('beta', true);
  collector.observe({
    v: 1,
    argsDigest: 'd1',
    phase: 'pre',
    patch: { why: 'test' },
  });
  const meta = collector.assembleTeachingMeta();
  assert.deepEqual(meta?.eligibleToolNames?.sort(), ['alpha', 'beta']);
}

// ── Mixed pre + post annotations ──

{
  // Both pre and post annotations can coexist
  const collector = new TeachingAnnotationCollector('detailed');
  collector.recordToolStart('deploy', { app: 'v1' });
  collector.recordToolResult('call-99', 'deploy');

  const digestDeploy = digestStudioToolCall('deploy', { app: 'v1' });
  collector.observe({
    v: 1,
    argsDigest: digestDeploy,
    phase: 'pre',
    patch: { why: 'deploy v1', concept: 'deployment' },
  });
  collector.observe({
    v: 1,
    toolCallId: 'call-99',
    phase: 'post',
    patch: { verifyHint: 'check logs', confidence: 'high' },
  });

  const meta = collector.assembleTeachingMeta();
  assert.equal(meta?.preAnnotations?.length, 1);
  assert.equal(meta?.postAnnotations?.length, 1);
  assert.equal(meta?.annotatedToolNames?.length, 1);
  assert.equal(meta?.annotatedToolNames?.[0], 'deploy');
}

console.log('All teaching-annotation-collector checks passed.');
