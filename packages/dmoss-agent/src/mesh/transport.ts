import http from 'node:http';
import type { MeshConfig, MeshMessage } from './types.js';
import { MESH_SECRET_HEADER, MAX_CLIENT_RESPONSE_BYTES } from './types.js';
import { isLoopbackHost, isPrivateOrLoopbackTarget, secureEquals } from './helpers.js';
import { getRootLogger } from '../logger.js';
import { DmossError, ErrorCode } from '../errors.js';

const log = getRootLogger().child('mesh:transport');

export class MeshTransport {
  private server: http.Server | null = null;
  private _running = false;

  constructor(private readonly sharedSecret: string) {}

  get isRunning(): boolean {
    return this._running;
  }

  async start(
    host: string,
    port: number,
    config: MeshConfig,
    handleMessage: (msg: MeshMessage) => Promise<Record<string, unknown>>,
    onStarted: () => void,
  ): Promise<void> {
    if (!isLoopbackHost(host) && !this.sharedSecret) {
      throw new DmossError({ code: ErrorCode.MESH_PEER_UNREACHABLE, message: 'DMOSS mesh requires sharedSecret when listening beyond loopback' });
    }

    this.server = http.createServer(async (req, res) => {
      if (!this.authorizeRequest(req, res)) return;
      if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: config.id,
            name: config.name,
            capabilities: config.capabilities || [],
            deviceInfo: config.deviceInfo || '',
          }),
        );
        return;
      }

      const MAX_BODY = 1 * 1024 * 1024;
      let body = '';
      let bodyLen = 0;
      for await (const chunk of req) {
        bodyLen += chunk.length;
        if (bodyLen > MAX_BODY) { req.destroy(); return; }
        body += chunk;
      }

      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || !parsed.type) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid message' }));
          return;
        }
        if (!parsed.payload || typeof parsed.payload !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid payload' }));
          return;
        }
        const msg: MeshMessage = parsed;
        const response = await handleMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        log.warn('mesh request parse/handle failed', { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request' }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      const onErr = (err: NodeJS.ErrnoException) => {
        srv.off('error', onErr);
        this._running = false;
        try {
          srv.close();
        } catch {
          /* noop */
        }
        reject(err);
      };
      srv.once('error', onErr);
      srv.listen(port, host, () => {
        srv.off('error', onErr);
        this._running = true;
        onStarted();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this._running || !this.server) return;
    this._running = false;
    return new Promise((resolve) => {
      const srv = this.server!;
      if (typeof srv.closeAllConnections === 'function') {
        srv.closeAllConnections();
      }
      srv.close(() => {
        this._running = false;
        resolve();
      });
    });
  }

  async sendToPeer(
    host: string,
    port: number,
    msg: MeshMessage,
  ): Promise<Record<string, unknown>> {
    const privateOrLoopback = await isPrivateOrLoopbackTarget(host);
    if (privateOrLoopback && !this.sharedSecret) {
      throw new DmossError({ code: ErrorCode.MESH_PEER_UNREACHABLE, message: `Refusing to send to private/loopback address without sharedSecret: ${host}` });
    }
    const res = await fetch(`http://${host}:${port}`, {
      method: 'POST',
      headers: this.meshHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new DmossError({ code: ErrorCode.MESH_PEER_UNREACHABLE, message: `mesh peer rejected request: HTTP ${res.status}` });

    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_CLIENT_RESPONSE_BYTES) {
      res.body?.cancel().catch(() => {});
      throw new DmossError({ code: ErrorCode.MESH_PEER_UNREACHABLE, message: 'peer response too large (Content-Length exceeds limit)' });
    }

    if (!res.body) {
      return res.json() as Promise<Record<string, unknown>>;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalLen += value.byteLength;
        if (totalLen > MAX_CLIENT_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new DmossError({ code: ErrorCode.MESH_PEER_UNREACHABLE, message: 'peer response exceeded maximum size during read' });
        }
        chunks.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return JSON.parse(buf.toString('utf-8')) as Record<string, unknown>;
  }

  async fetchPeerInfo(
    host: string,
    port: number,
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`http://${host}:${port}`, {
        method: 'GET',
        headers: this.meshHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private meshHeaders(base: Record<string, string> = {}): Record<string, string> {
    if (!this.sharedSecret) return base;
    return { ...base, [MESH_SECRET_HEADER]: this.sharedSecret };
  }

  private authorizeRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.sharedSecret) return true;
    const raw = req.headers[MESH_SECRET_HEADER];
    const headerSecret = Array.isArray(raw) ? raw[0] : raw;
    const authRaw = req.headers.authorization;
    const auth = Array.isArray(authRaw) ? authRaw[0] : authRaw;
    const bearerSecret = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    const received = headerSecret || bearerSecret;
    if (received && secureEquals(received, this.sharedSecret)) return true;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'mesh authentication required' }));
    return false;
  }
}
