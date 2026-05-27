import type { MeshPeer, MeshMessage } from './types.js';
import type { MeshEventBus } from './mesh-events.js';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('mesh:registry');

export class PeerRegistry {
  private peers = new Map<string, MeshPeer>();
  private eventBus: MeshEventBus | null = null;

  constructor(private readonly peerTtlMs: number) {}

  setEventBus(bus: MeshEventBus): void {
    this.eventBus = bus;
  }

  add(peer: MeshPeer): boolean {
    const isNew = !this.peers.has(peer.id);
    if (!isNew) {
      const existing = this.peers.get(peer.id)!;
      if (existing.host !== peer.host || existing.port !== peer.port) {
        log.warn('peer identity overwritten from different address', {
          peerId: peer.id,
          previousHost: `${existing.host}:${existing.port}`,
          newHost: `${peer.host}:${peer.port}`,
        });
      }
    }
    this.peers.set(peer.id, peer);

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

    return isNew;
  }

  get(id: string): MeshPeer | undefined {
    return this.peers.get(id);
  }

  list(): MeshPeer[] {
    return [...this.peers.values()];
  }

  remove(id: string, reason: string = 'manual'): void {
    const peer = this.peers.get(id);
    if (peer) {
      this.peers.delete(id);
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

  evictStale(): void {
    const cutoff = Date.now() - this.peerTtlMs;
    for (const [id, peer] of this.peers) {
      if (peer.lastSeen < cutoff) {
        this.remove(id, 'ttl_expired');
      }
    }
  }

  static makePeerFromMessage(msg: MeshMessage): MeshPeer {
    return {
      id: msg.fromId,
      name: msg.fromName,
      host: String(msg.payload.host || ''),
      port: Number(msg.payload.port || 0),
      capabilities: Array.isArray(msg.payload.capabilities) ? (msg.payload.capabilities as string[]) : [],
      deviceInfo: String(msg.payload.deviceInfo || ''),
      lastSeen: Date.now(),
    };
  }
}
