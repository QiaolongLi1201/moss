#!/usr/bin/env node
/**
 * Regression test for the `web_fetch` streaming body cap.
 *
 * Previously `web_fetch` did `await res.arrayBuffer()` and then truncated
 * post-hoc, so a multi-MB response still fully buffered into the agent
 * process. After the fix the tool streams the ReadableStream, cancelling the
 * reader (and therefore the underlying HTTP socket) as soon as `maxBytes` is
 * reached.
 *
 * This test verifies:
 *   1. Output length is capped at `maxBytes` for oversized bodies.
 *   2. The HTTP server observes an early close — proving the client did NOT
 *      buffer the entire response in memory before truncating.
 *   3. Small (<= maxBytes) responses still come through intact.
 *   4. The truncated path reports `(body truncated)` in the header line.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

const { createWebFetchTool } = await import('../dist/tools/web-fetch.js');

function makeStreamer(sizeBytes, chunkSize = 4096, chunkDelayMs = 0) {
  /**
   * Returns an HTTP server that streams `sizeBytes` of 'x' in `chunkSize`
   * chunks. Tracks `bytesSent`, `socketClosed`, and `finished` so the test can
   * assert the client closed the connection early.
   */
  const state = { bytesSent: 0, finished: false, socketClosed: false, socket: null };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    state.socket = req.socket;
    sockets.add(req.socket);
    req.socket.on('close', () => {
      sockets.delete(req.socket);
      state.socketClosed = true;
    });
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      // Deliberately don't set Content-Length so the client can't short-circuit
      // based on headers alone — it must actually stop reading the stream.
    });
    const write = () => {
      while (state.bytesSent < sizeBytes) {
        const remaining = sizeBytes - state.bytesSent;
        const len = Math.min(chunkSize, remaining);
        const chunk = Buffer.alloc(len, 0x78 /* 'x' */);
        const ok = res.write(chunk);
        state.bytesSent += len;
        if (!ok) {
          res.once('drain', write);
          return;
        }
        if (chunkDelayMs > 0) {
          setTimeout(write, chunkDelayMs);
          return;
        }
      }
      state.finished = true;
      res.end();
    };
    write();
  });
  const closeAll = () => {
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        /* best-effort teardown */
      }
    }
    sockets.clear();
  };
  return { server, state, closeAll };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
  return addr.port;
}

/**
 * Test 1+2: Large response is truncated and server socket is closed early.
 * We stream 1 MB in small chunks with a per-chunk delay so the client has a
 * real chance to read some bytes and cancel before the server finishes.
 */
async function testStreamingTruncation() {
  const totalSize = 1024 * 1024; // 1 MB
  const maxBytes = 8 * 1024; // 8 KB cap
  const { server, state, closeAll } = makeStreamer(totalSize, 1024, 2);
  const port = await listen(server);
  try {
    const tool = createWebFetchTool({
      blockPrivateNetwork: false,
      maxBytes,
      timeoutMs: 10_000,
    });
    const result = await tool.execute(
      { url: `http://127.0.0.1:${port}/big` },
      { workspaceDir: '/tmp', sessionKey: 'web-fetch-maxbytes-stream' },
    );

    // Header line must report truncation
    assert.match(result, /\(body truncated\)/, 'header must report body truncation');
    assert.match(
      result,
      new RegExp(`· HTTP 200 · ${maxBytes}B`),
      `header must report exactly ${maxBytes} bytes read`,
    );

    // Wait briefly for the server to observe the closed socket
    const deadline = Date.now() + 2_000;
    while (!state.socketClosed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // The server must NOT have finished streaming the full 1 MB.
    // If `state.finished` is true, the client buffered the entire body first.
    assert.equal(
      state.finished,
      false,
      `server must not have finished writing all ${totalSize} bytes; client should have cancelled the stream early (bytesSent=${state.bytesSent})`,
    );
    assert.ok(
      state.bytesSent < totalSize,
      `server must have sent fewer than ${totalSize} bytes (sent ${state.bytesSent})`,
    );
  } finally {
    closeAll();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Test 3: Small (<= maxBytes) responses come through intact.
 */
async function testSmallResponseIntact() {
  const body = 'hello web_fetch, this is a small response.';
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    req.socket.on('close', () => sockets.delete(req.socket));
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
  const port = await listen(server);
  try {
    const tool = createWebFetchTool({
      blockPrivateNetwork: false,
      maxBytes: 1024,
      timeoutMs: 5_000,
    });
    const result = await tool.execute(
      { url: `http://127.0.0.1:${port}/small` },
      { workspaceDir: '/tmp', sessionKey: 'web-fetch-maxbytes-stream-small' },
    );
    assert.doesNotMatch(result, /\(body truncated\)/, 'small response must not be marked truncated');
    assert.match(result, new RegExp(body), 'small response body must appear verbatim');
  } finally {
    for (const s of sockets) {
      try { s.destroy(); } catch { /* best-effort */ }
    }
    sockets.clear();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Test 4: Exactly-at-cap response (size === maxBytes) is NOT truncated.
 */
async function testExactCapNotTruncated() {
  const maxBytes = 4096;
  const { server, closeAll } = makeStreamer(maxBytes, 512, 0);
  const port = await listen(server);
  try {
    const tool = createWebFetchTool({
      blockPrivateNetwork: false,
      maxBytes,
      timeoutMs: 5_000,
    });
    const result = await tool.execute(
      { url: `http://127.0.0.1:${port}/exact` },
      { workspaceDir: '/tmp', sessionKey: 'web-fetch-maxbytes-stream-exact' },
    );
    assert.doesNotMatch(result, /\(body truncated\)/, 'exactly-at-cap response must not be marked truncated');
    assert.match(
      result,
      new RegExp(`· HTTP 200 · ${maxBytes}B `),
      `must report exactly ${maxBytes} bytes`,
    );
  } finally {
    closeAll();
    await new Promise((resolve) => server.close(resolve));
  }
}

await testStreamingTruncation();
await testSmallResponseIntact();
await testExactCapNotTruncated();

console.log('[PASS] web_fetch streams the body and cancels at maxBytes without buffering the full response');
