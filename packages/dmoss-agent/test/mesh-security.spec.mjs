#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { AgentMesh, createMeshTools } from '../dist/mesh/index.js';

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function testNonLoopbackRequiresSecret() {
  const mesh = new AgentMesh({
    id: 'unsafe',
    name: 'Unsafe Mesh',
    port: await getFreePort(),
    listenHost: '0.0.0.0',
  });
  await assert.rejects(
    () => mesh.start(),
    /requires sharedSecret/,
    'non-loopback mesh listeners must not start without a shared secret',
  );
}

async function testSharedSecretGuardsMetadataEndpoint() {
  const port = await getFreePort();
  const mesh = new AgentMesh({
    id: 'secret-peer',
    name: 'Secret Peer',
    port,
    listenHost: '127.0.0.1',
    sharedSecret: 'mesh-secret',
  });
  await mesh.start();
  try {
    const unauth = await fetch(`http://127.0.0.1:${port}`);
    assert.equal(unauth.status, 401, 'metadata endpoint rejects missing shared secret');

    const auth = await fetch(`http://127.0.0.1:${port}`, {
      headers: { 'x-dmoss-mesh-secret': 'mesh-secret' },
    });
    assert.equal(auth.status, 200, 'metadata endpoint accepts the shared secret');
    const body = await auth.json();
    assert.equal(body.id, 'secret-peer');
  } finally {
    await mesh.stop();
  }
}

async function testLanDiscoveryCanOptIntoPrivatePeerProbe() {
  const port = await getFreePort();
  const peer = new AgentMesh({
    id: 'lan-peer',
    name: 'LAN Peer',
    port,
    listenHost: '127.0.0.1',
    sharedSecret: 'mesh-secret',
  });
  await peer.start();
  try {
    const local = new AgentMesh({
      id: 'local',
      name: 'Local',
      sharedSecret: 'mesh-secret',
    });
    assert.equal(
      await local.discoverPeer('127.0.0.1', port),
      null,
      'manual discovery still blocks private targets by default',
    );
    const noSecret = new AgentMesh({
      id: 'no-secret',
      name: 'No Secret',
    });
    assert.equal(
      await noSecret.discoverPeer('127.0.0.1', port, { allowPrivate: true }),
      null,
      'private peer probe requires a local shared secret',
    );

    const discovered = await local.discoverPeer('127.0.0.1', port, { allowPrivate: true });
    assert.equal(discovered?.id, 'lan-peer', 'LAN discovery path can probe private peers');

    const wrongSecret = new AgentMesh({
      id: 'wrong-secret',
      name: 'Wrong Secret',
      sharedSecret: 'wrong',
    });
    assert.equal(
      await wrongSecret.discoverPeer('127.0.0.1', port, { allowPrivate: true }),
      null,
      'private peer probe still requires the shared secret',
    );
  } finally {
    await peer.stop();
  }
}

async function testMeshDiscoverToolFindsLanPeer() {
  const port = await getFreePort();
  const peer = new AgentMesh({
    id: 'tool-lan-peer',
    name: 'Tool LAN Peer',
    port,
    listenHost: '127.0.0.1',
    sharedSecret: 'tool-mesh-secret',
  });
  await peer.start();
  try {
    const local = new AgentMesh({
      id: 'tool-local',
      name: 'Tool Local',
      sharedSecret: 'tool-mesh-secret',
    });
    const tools = createMeshTools(local);
    const discover = tools.find((t) => t.name === 'mesh_discover');
    assert.ok(discover, 'mesh_discover tool must exist');

    const result = await discover.execute({ host: '127.0.0.1', port }, {});
    assert.ok(
      result.includes('tool-lan-peer'),
      `mesh_discover must find LAN peer on private address, got: ${result}`,
    );
  } finally {
    await peer.stop();
  }
}

async function testMeshDiscoverToolRejectsPrivateWithoutSecret() {
  const port = await getFreePort();
  const peer = new AgentMesh({
    id: 'tool-secure-peer',
    name: 'Tool Secure Peer',
    port,
    listenHost: '127.0.0.1',
    sharedSecret: 'required-secret',
  });
  await peer.start();
  try {
    const noSecret = new AgentMesh({
      id: 'tool-no-secret',
      name: 'Tool No Secret',
    });
    const tools = createMeshTools(noSecret);
    const discover = tools.find((t) => t.name === 'mesh_discover');
    assert.ok(discover, 'mesh_discover tool must exist');

    const result = await discover.execute({ host: '127.0.0.1', port }, {});
    assert.ok(
      result.includes('No D-Moss agent found'),
      `mesh_discover without sharedSecret must not probe private peers, got: ${result}`,
    );
  } finally {
    await peer.stop();
  }
}

await testNonLoopbackRequiresSecret();
await testSharedSecretGuardsMetadataEndpoint();
await testLanDiscoveryCanOptIntoPrivatePeerProbe();
await testMeshDiscoverToolFindsLanPeer();
await testMeshDiscoverToolRejectsPrivateWithoutSecret();

console.log('[PASS] mesh security and LAN discovery checks passed');
