/**
 * Multi-agent mesh (HTTP + LAN discovery) — used by the dmoss-agent CLI and by any host application that embeds DmossAgent.
 */
export { AgentMesh, createMeshTools, isMeshVerboseEnabled } from './agent-mesh.js';
export type { MeshConfig, MeshPeer, MeshMessage } from './agent-mesh.js';
export { LanDiscovery } from './lan-discovery.js';
export { MeshEventBus } from './mesh-events.js';
export type {
  MeshEvent,
  MeshEventSink,
  MeshJoinedEvent,
  MeshLeftEvent,
  ChildRunStartedEvent,
  ChildRunProgressEvent,
  ChildRunCompletedEvent,
  ChildRunFailedEvent,
  ApprovalRequestedEvent,
  CancellationPropagatedEvent,
} from './mesh-events.js';
