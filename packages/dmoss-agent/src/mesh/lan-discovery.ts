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
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('mesh:lan-discovery');

const BROADCAST_PORT = parseInt(process.env.DMOSS_MESH_DISCOVERY_PORT || '9091', 10) || 9091;
const BROADCAST_INTERVAL_MS = 10_000;

export interface LanDiscoveryConfig {
  mesh: AgentMesh;
  meshPort: number;
  agentId: string;
  agentName: string;
  /** Capabilities to advertise in broadcast announcements. */
  capabilities?: string[];
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
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly peerTtlMs: number;
  private readonly config: LanDiscoveryConfig;
  private running = false;
  private onPeerDiscovered: ((peer: MeshPeer) => void) | null = null;

  constructor(config: LanDiscoveryConfig) {
    this.config = config;
    this.peerTtlMs = Number(process.env.DMOSS_MESH_PEER_TTL_MS) || 5 * 60 * 1000;
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
        if (!msg.id || typeof msg.id !== 'string') return;
        if (typeof msg.name !== 'string') msg.name = msg.id;
        if (msg.id === this.config.agentId) return;

        // L1: Validate meshPort
        const port = Number(msg.meshPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return;

        // L1: Validate capabilities
        if (!Array.isArray(msg.capabilities)) msg.capabilities = [];

        const existing = this.config.mesh.getPeers().find(p => p.id === msg.id);
        if (!existing) {
          // L2: Log peer discovery failures instead of swallowing them
          this.config.mesh.discoverPeer(rinfo.address, port, { allowPrivate: true })
            .then((discovered) => {
              if (discovered && this.onPeerDiscovered) this.onPeerDiscovered(discovered);
            })
            .catch((err) => log.warn('peer discovery failed', { error: err?.message ?? String(err) }));
        }
      } catch { /* ignore invalid messages */ }
    });

    return new Promise((resolve, reject) => {
      this.socket!.bind(BROADCAST_PORT, () => {
        this.socket!.setBroadcast(true);
        this.running = true;

        this.broadcast();
        this.timer = setInterval(() => this.broadcast(), BROADCAST_INTERVAL_MS);
        this.timer.unref?.();

        // Periodic stale peer eviction (synced with mesh peer list)
        this.expiryTimer = setInterval(() => this.evictStalePeers(), 60_000);
        this.expiryTimer.unref?.();

        resolve();
      });
      this.socket!.on('error', (err) => {
        if (!this.running) {
          reject(err);
        } else {
          log.error('socket error after startup', { error: err?.message ?? String(err) });
        }
      });
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
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
      capabilities: this.config.capabilities ?? [],
    };

    const buf = Buffer.from(JSON.stringify(msg));
    const addresses = this.getAllBroadcastAddresses();

    for (const addr of addresses) {
      try {
        this.socket.send(buf, 0, buf.length, BROADCAST_PORT, addr);
      } catch {
        /* broadcast might fail on some networks */
      }
    }
  }

  private getAllBroadcastAddresses(): string[] {
    const interfaces = os.networkInterfaces();
    const addresses: string[] = [];
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const info of iface) {
        if (info.family === 'IPv4' && !info.internal) {
          const parts = info.address.split('.');
          const maskParts = info.netmask.split('.');
          const broadcast = parts.map((p, i) =>
            (parseInt(p) | (~parseInt(maskParts[i]) & 255)).toString()
          ).join('.');
          addresses.push(broadcast);
        }
      }
    }
    if (addresses.length === 0) {
      addresses.push('255.255.255.255');
    }
    return addresses;
  }

  private evictStalePeers(): void {
    const cutoff = Date.now() - this.peerTtlMs;
    const peers = this.config.mesh.getPeers();
    for (const peer of peers) {
      if (peer.lastSeen < cutoff) {
        this.config.mesh.removePeer(peer.id, 'discovery_ttl_expired');
      }
    }
  }
}
