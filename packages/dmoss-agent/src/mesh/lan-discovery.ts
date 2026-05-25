/**
 * LAN Auto-Discovery — D-Moss agents automatically find each other on the local network.
 *
 * Uses UDP broadcast: each agent periodically broadcasts its presence,
 * and listens for other agents' announcements.
 *
 * Also implements idle push notifications: when a peer asks a question
 * and this agent is idle, the question is displayed in the terminal.
 */

import dgram from 'node:dgram';
import os from 'node:os';
import type { AgentMesh, MeshPeer } from './agent-mesh.js';

const BROADCAST_PORT = parseInt(process.env.DMOSS_MESH_DISCOVERY_PORT || '9091', 10) || 9091;
const BROADCAST_INTERVAL_MS = 10_000;

export interface LanDiscoveryConfig {
  mesh: AgentMesh;
  meshPort: number;
  agentId: string;
  agentName: string;
}

interface BroadcastMessage {
  type: 'dmoss-announce';
  id: string;
  name: string;
  meshPort: number;
  capabilities: string[];
  deviceInfo?: string;
}

export class LanDiscovery {
  private socket: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly config: LanDiscoveryConfig;
  private running = false;
  private onPeerDiscovered: ((peer: MeshPeer) => void) | null = null;

  constructor(config: LanDiscoveryConfig) {
    this.config = config;
  }

  onNewPeer(handler: (peer: MeshPeer) => void): void {
    this.onPeerDiscovered = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('message', (data, rinfo) => {
      try {
        const msg: BroadcastMessage = JSON.parse(data.toString());
        if (msg.type !== 'dmoss-announce') return;
        if (msg.id === this.config.agentId) return;

        // L1: Validate meshPort
        const port = Number(msg.meshPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return;

        // L1: Validate capabilities
        if (!Array.isArray(msg.capabilities)) msg.capabilities = [];

        const peer: MeshPeer = {
          id: msg.id,
          name: msg.name,
          host: rinfo.address,
          port: port,
          capabilities: msg.capabilities || [],
          deviceInfo: msg.deviceInfo,
          lastSeen: Date.now(),
        };

        const existing = this.config.mesh.getPeers().find(p => p.id === msg.id);
        if (!existing) {
          // L2: Log peer discovery failures instead of swallowing them
          this.config.mesh.discoverPeer(rinfo.address, port).catch((err) => console.warn('[lan-discovery] peer discovery failed:', err?.message ?? err));
          if (this.onPeerDiscovered) {
            this.onPeerDiscovered(peer);
          }
        }
      } catch { /* ignore invalid messages */ }
    });

    return new Promise((resolve, reject) => {
      this.socket!.bind(BROADCAST_PORT, () => {
        this.socket!.setBroadcast(true);
        this.running = true;

        this.broadcast();
        this.timer = setInterval(() => this.broadcast(), BROADCAST_INTERVAL_MS);

        resolve();
      });
      this.socket!.on('error', (err) => {
        if (!this.running) reject(err);
      });
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  private broadcast(): void {
    if (!this.socket) return;

    const msg: BroadcastMessage = {
      type: 'dmoss-announce',
      id: this.config.agentId,
      name: this.config.agentName,
      meshPort: this.config.meshPort,
      capabilities: [],
    };

    const buf = Buffer.from(JSON.stringify(msg));
    const broadcastAddr = this.getBroadcastAddress();

    try {
      this.socket.send(buf, 0, buf.length, BROADCAST_PORT, broadcastAddr);
    } catch { /* broadcast might fail on some networks */ }
  }

  private getBroadcastAddress(): string {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const info of iface) {
        if (info.family === 'IPv4' && !info.internal) {
          const parts = info.address.split('.');
          const maskParts = info.netmask.split('.');
          const broadcast = parts.map((p, i) =>
            (parseInt(p) | (~parseInt(maskParts[i]) & 255)).toString()
          ).join('.');
          return broadcast;
        }
      }
    }
    return '255.255.255.255';
  }
}
