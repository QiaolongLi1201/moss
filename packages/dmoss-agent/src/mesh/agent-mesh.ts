/**
 * D-Moss Agent Mesh — multi-agent collaboration network.
 *
 * Enables D-Moss agents connected to different devices to discover each other,
 * exchange knowledge, and collaboratively solve problems.
 *
 * Architecture:
 *   - Each agent registers itself on the mesh with its capabilities and device info
 *   - Agents can broadcast questions to the mesh
 *   - Other agents respond with suggestions or information based on their knowledge
 *   - Learned skills and memories can be shared across the mesh
 *
 * Transport: HTTP (simple, works across networks)
 *
 * This is D-Moss's core differentiator — no other agent framework has
 * multi-agent robotics collaboration built in.
 */

import http from 'node:http';
import type { Tool } from '../core/tool-types.js';
import type { MeshEventBus } from './mesh-events.js';

export interface MeshPeer {
  id: string;
  name: string;
  host: string;
  port: number;
  capabilities: string[];
  deviceInfo?: string;
  lastSeen: number;
}

export interface MeshConfig {
  id: string;
  name: string;
  port?: number;
  /** HTTP bind address (default `0.0.0.0` so LAN peers can reach the service). */
  listenHost?: string;
  peers?: Array<{ host: string; port: number }>;
  capabilities?: string[];
  deviceInfo?: string;
  allowIncoming?: boolean;
}

export interface MeshMessage {
  type: 'query' | 'response' | 'announce' | 'share_skill' | 'share_memory';
  fromId: string;
  fromName: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

type QueryHandler = (query: string, fromPeer: MeshPeer) => Promise<string>;
type ShareSkillHandler = (skill: Record<string, unknown>, fromPeer: MeshPeer) => Promise<{ accepted: boolean; reason?: string }>;
type ShareMemoryHandler = (memory: Record<string, unknown>, fromPeer: MeshPeer) => Promise<{ accepted: boolean; reason?: string }>;

/** Set `DMOSS_MESH_VERBOSE=true` to print mesh traffic and (from CLI) startup / peer logs. */
export function isMeshVerboseEnabled(): boolean {
  return process.env.DMOSS_MESH_VERBOSE === 'true';
}

export class AgentMesh {
  private readonly config: MeshConfig;
  private readonly port: number;
  private peers = new Map<string, MeshPeer>();
  private server: http.Server | null = null;
  private queryHandler: QueryHandler | null = null;
  private shareSkillHandler: ShareSkillHandler | null = null;
  private shareMemoryHandler: ShareMemoryHandler | null = null;
  private running = false;
  private eventBus: MeshEventBus | null = null;

  constructor(config: MeshConfig) {
    this.config = config;
    this.port = config.port || 9090;
  }

  onQuery(handler: QueryHandler): void {
    this.queryHandler = handler;
  }

  onShareSkill(handler: ShareSkillHandler): void {
    this.shareSkillHandler = handler;
  }

  onShareMemory(handler: ShareMemoryHandler): void {
    this.shareMemoryHandler = handler;
  }

  /** Attach an event bus so the mesh emits structured lifecycle events. */
  setEventBus(bus: MeshEventBus): void {
    this.eventBus = bus;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.server = http.createServer(async (req, res) => {
      // M5: TODO(security): mesh HTTP server has no authentication. Consider adding a shared secret or token for production deployments.
      if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: this.config.id,
            name: this.config.name,
            capabilities: this.config.capabilities || [],
            deviceInfo: this.config.deviceInfo || '',
          }),
        );
        return;
      }

      // H4: Bound request body size to prevent DoS
      const MAX_BODY = 1 * 1024 * 1024;
      let body = '';
      let bodyLen = 0;
      for await (const chunk of req) {
        bodyLen += chunk.length;
        if (bodyLen > MAX_BODY) { req.destroy(); return; }
        body += chunk;
      }

      try {
        const msg: MeshMessage = JSON.parse(body);
        const response = await this.handleMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });

    const host = this.config.listenHost ?? '0.0.0.0';

    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      const onErr = (err: NodeJS.ErrnoException) => {
        srv.off('error', onErr);
        this.running = false;
        try {
          srv.close();
        } catch {
          /* noop */
        }
        reject(err);
      };
      srv.once('error', onErr);
      srv.listen(this.port, host, () => {
        srv.off('error', onErr);
        this.running = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.running = false;
        resolve();
      });
    });
  }

  private async handleMessage(msg: MeshMessage): Promise<Record<string, unknown>> {
    switch (msg.type) {
      case 'announce': {
        const peer: MeshPeer = {
          id: msg.fromId,
          name: msg.fromName,
          host: String(msg.payload.host || ''),
          port: Number(msg.payload.port || 9090),
          capabilities: (msg.payload.capabilities as string[]) || [],
          deviceInfo: String(msg.payload.deviceInfo || ''),
          lastSeen: Date.now(),
        };
        const isNew = !this.peers.has(msg.fromId);
        this.peers.set(msg.fromId, peer);

        if (isNew && this.eventBus) {
          this.eventBus.emit({
            type: 'mesh_joined',
            peerId: peer.id,
            peerName: peer.name,
            capabilities: peer.capabilities,
            deviceInfo: peer.deviceInfo || '',
            timestamp: Date.now(),
          });
        }

        return { ack: true, peerId: this.config.id };
      }

      case 'query': {
        if (this.config.allowIncoming === false) {
          return {
            response: '(this agent has not enabled incoming queries)',
            fromId: this.config.id,
            fromName: this.config.name,
          };
        }

        const query = String(msg.payload.query || '');
        const fromPeer: MeshPeer = {
          id: msg.fromId,
          name: msg.fromName,
          host: '',
          port: 0,
          capabilities: [],
          lastSeen: Date.now(),
        };

        if (isMeshVerboseEnabled()) {
          console.error(
            `\n[mesh] 📨 Incoming query from ${msg.fromName}: "${query.slice(0, 100)}"`,
          );
        }

        if (this.queryHandler) {
          const response = await this.queryHandler(query, fromPeer);
          if (isMeshVerboseEnabled()) {
            console.error(`[mesh] ✅ Responded to ${msg.fromName}`);
          }
          return { response, fromId: this.config.id, fromName: this.config.name };
        }
        return { response: '(no handler)', fromId: this.config.id };
      }

      case 'share_skill': {
        if (!this.shareSkillHandler) {
          return { error: 'skill sharing not configured on this peer' };
        }
        const skillPeer = this.makePeerFromMessage(msg);
        const result = await this.shareSkillHandler(msg.payload as Record<string, unknown>, skillPeer);
        return { ack: result.accepted, reason: result.reason, peerId: this.config.id };
      }

      case 'share_memory': {
        if (!this.shareMemoryHandler) {
          return { error: 'memory sharing not configured on this peer' };
        }
        const memPeer = this.makePeerFromMessage(msg);
        const result = await this.shareMemoryHandler(msg.payload as Record<string, unknown>, memPeer);
        return { ack: result.accepted, reason: result.reason, peerId: this.config.id };
      }

      default:
        return { error: `unknown message type: ${msg.type}` };
    }
  }

  async announce(): Promise<void> {
    const msg: MeshMessage = {
      type: 'announce',
      fromId: this.config.id,
      fromName: this.config.name,
      payload: {
        host: 'localhost',
        port: this.port,
        capabilities: this.config.capabilities || [],
        deviceInfo: this.config.deviceInfo || '',
      },
      timestamp: Date.now(),
    };

    for (const peer of this.config.peers || []) {
      try {
        await this.sendToPeer(peer.host, peer.port, msg);
      } catch {
        /* peer offline */
      }
    }
  }

  async queryPeers(
    query: string,
  ): Promise<Array<{ peerId: string; peerName: string; response: string }>> {
    const results: Array<{ peerId: string; peerName: string; response: string }> = [];

    const msg: MeshMessage = {
      type: 'query',
      fromId: this.config.id,
      fromName: this.config.name,
      payload: { query },
      timestamp: Date.now(),
    };

    const peerList = [...this.peers.values()];
    const requests = peerList.map(async (peer) => {
      try {
        const res = await this.sendToPeer(peer.host, peer.port, msg);
        if (res.response) {
          results.push({
            peerId: peer.id,
            peerName: peer.name,
            response: String(res.response),
          });
        }
      } catch {
        /* peer offline */
      }
    });

    await Promise.allSettled(requests);
    return results;
  }

  async discoverPeer(host: string, port: number): Promise<MeshPeer | null> {
    // M1: SSRF protection — reject private/loopback IPs
    const hostStr = String(host);
    if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|localhost)/i.test(hostStr)) {
      return null;
    }
    try {
      const res = await fetch(`http://${host}:${port}`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as Record<string, unknown>;
      const peer: MeshPeer = {
        id: String(data.id || `${host}:${port}`),
        name: String(data.name || 'Unknown'),
        host,
        port,
        capabilities: (data.capabilities as string[]) || [],
        deviceInfo: String(data.deviceInfo || ''),
        lastSeen: Date.now(),
      };
      this.peers.set(peer.id, peer);
      return peer;
    } catch {
      return null;
    }
  }

  getPeers(): MeshPeer[] {
    return [...this.peers.values()];
  }

  /** Remove a peer by id. Emits mesh_left if the peer was known. */
  removePeer(peerId: string, reason: string = 'manual'): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      this.peers.delete(peerId);
      if (this.eventBus) {
        this.eventBus.emit({
          type: 'mesh_left',
          peerId: peer.id,
          reason,
          timestamp: Date.now(),
        });
      }
    }
  }

  private makePeerFromMessage(msg: MeshMessage): MeshPeer {
    return {
      id: msg.fromId,
      name: msg.fromName,
      host: '',
      port: 0,
      capabilities: [],
      lastSeen: Date.now(),
    };
  }

  private async sendToPeer(
    host: string,
    port: number,
    msg: MeshMessage,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`http://${host}:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(10_000),
    });
    return res.json() as Promise<Record<string, unknown>>;
  }
}

/**
 * Create tools that enable mesh collaboration in the agent.
 */
export function createMeshTools(mesh: AgentMesh): Tool[] {
  const meshQuery: Tool = {
    name: 'mesh_ask_peers',
    description:
      'Ask other D-Moss agents in the mesh network for help or information. Use when you need expertise from agents connected to other devices.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to broadcast to peer agents' },
      },
      required: ['question'],
    },
    async execute(input) {
      const results = await mesh.queryPeers(input.question);
      if (results.length === 0)
        return 'No peer agents responded. The mesh may be empty or peers are offline.';
      return results.map((r) => `[${r.peerName}] ${r.response}`).join('\n\n---\n\n');
    },
  };

  const meshPeers: Tool = {
    name: 'mesh_list_peers',
    description: 'List all discovered D-Moss peer agents in the mesh network.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const peers = mesh.getPeers();
      if (peers.length === 0) return 'No peers discovered yet.';
      return peers
        .map(
          (p) =>
            `• ${p.name} (${p.host}:${p.port}) — ${p.capabilities.join(', ') || 'general'} — device: ${p.deviceInfo || 'unknown'}`,
        )
        .join('\n');
    },
  };

  const meshDiscover: Tool = {
    name: 'mesh_discover',
    description: 'Discover a D-Moss peer agent at a specific address.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Peer hostname or IP' },
        port: { type: 'number', description: 'Peer mesh port (default: 9090)' },
      },
      required: ['host'],
    },
    async execute(input) {
      const port = input.port || 9090;
      const peer = await mesh.discoverPeer(input.host, port);
      if (!peer) return `No D-Moss agent found at ${input.host}:${port}`;
      return `Discovered: ${peer.name} (${peer.id}) — capabilities: ${peer.capabilities.join(', ') || 'general'} — device: ${peer.deviceInfo || 'unknown'}`;
    },
  };

  return [meshQuery, meshPeers, meshDiscover];
}
