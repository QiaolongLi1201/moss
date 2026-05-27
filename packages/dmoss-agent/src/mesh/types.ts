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
  /** HTTP bind address. Defaults to loopback; LAN exposure requires `sharedSecret`. */
  listenHost?: string;
  /** Optional shared secret required by peers. Required when listening beyond loopback. */
  sharedSecret?: string;
  peers?: Array<{ host: string; port: number }>;
  capabilities?: string[];
  deviceInfo?: string;
  allowIncoming?: boolean;
  /** Maximum outgoing mesh queries per minute (token bucket). Default: 30. */
  maxQueriesPerMinute?: number;
}

export interface MeshMessage {
  type: 'query' | 'response' | 'announce' | 'share_skill' | 'share_memory';
  fromId: string;
  fromName: string;
  payload: Record<string, unknown>;
  timestamp: number;
  traceId?: string;
  callDepth?: number;
}

export type QueryHandler = (query: string, fromPeer: MeshPeer) => Promise<string>;
export type ShareSkillHandler = (skill: Record<string, unknown>, fromPeer: MeshPeer) => Promise<{ accepted: boolean; reason?: string }>;
export type ShareMemoryHandler = (memory: Record<string, unknown>, fromPeer: MeshPeer) => Promise<{ accepted: boolean; reason?: string }>;
export type HostAddressResolver = (hostname: string) => Promise<string[]>;

export const MESH_SECRET_HEADER = 'x-dmoss-mesh-secret';
export const DNS_CHECK_TIMEOUT_MS = 3_000;
export const MESH_QUERY_GLOBAL_TIMEOUT_MS = 15_000;
export const MAX_PEER_RESPONSE_CHARS = 4096;
export const MAX_CLIENT_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_QUERIES_PER_MINUTE = 30;

export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<\|im_start\|>/i,
  /disregard\s+(all\s+)?prior/i,
];

export function containsPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}
