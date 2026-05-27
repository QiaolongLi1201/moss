/**
 * Agent Mesh — stable event protocol.
 *
 * Structured events emitted by the mesh and sub-agent runtime so product hosts
 * (UI, logging, telemetry) can consume agent activity without parsing text.
 *
 * Event shape is intentionally flat so consumers can filter on `type` without
 * inspecting nested payloads.
 */

// ── Mesh lifecycle events ──────────────────────────────────────

export interface MeshJoinedEvent {
  type: 'mesh_joined';
  peerId: string;
  peerName: string;
  capabilities: string[];
  deviceInfo: string;
  timestamp: number;
}

export interface MeshLeftEvent {
  type: 'mesh_left';
  peerId: string;
  reason: string;
  timestamp: number;
}

// ── Sub-agent (child run) events ──────────────────────────────

export interface ChildRunStartedEvent {
  type: 'child_run_started';
  runId: string;
  parentRunId: string;
  scope: string;
  toolSet: string[];
  timestamp: number;
}

export interface ChildRunProgressEvent {
  type: 'child_run_progress';
  runId: string;
  turn: number;
  toolCalls: string[];
  status: 'running' | 'waiting_for_tools' | 'summarizing';
  timestamp: number;
}

export interface ChildRunCompletedEvent {
  type: 'child_run_completed';
  runId: string;
  summary: string;
  toolResults: number;
  turns: number;
  durationMs: number;
  timestamp: number;
}

export interface ChildRunFailedEvent {
  type: 'child_run_failed';
  runId: string;
  error: string;
  category: string;
  timestamp: number;
}

// ── Approval events ────────────────────────────────────────────

export interface ApprovalRequestedEvent {
  type: 'approval_requested';
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
  sideEffectClass: string;
  timestamp: number;
}

// ── Cancellation events ────────────────────────────────────────

export interface CancellationPropagatedEvent {
  type: 'cancellation_propagated';
  runId: string;
  source: string;
  targetRuns: string[];
  timestamp: number;
}

// ── Union type ──────────────────────────────────────────────────

export type MeshEvent =
  | MeshJoinedEvent
  | MeshLeftEvent
  | ChildRunStartedEvent
  | ChildRunProgressEvent
  | ChildRunCompletedEvent
  | ChildRunFailedEvent
  | ApprovalRequestedEvent
  | CancellationPropagatedEvent;

// ── Event emitter interface ─────────────────────────────────────

export interface MeshEventSink {
  emit(event: MeshEvent): void;
}

/**
 * Simple in-process event bus for mesh + sub-agent events.
 * Hosts can replace with their own transport (WebSocket, IPC, etc.).
 */
export class MeshEventBus implements MeshEventSink {
  private listeners: Array<(event: MeshEvent) => void> = [];

  emit(event: MeshEvent): void {
    // Snapshot listeners to prevent mutation-during-iteration when a listener unsubscribes
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try { listener(event); } catch { /* don't let one listener break others */ }
    }
  }

  on(listener: (event: MeshEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Remove all listeners. */
  clear(): void {
    this.listeners.length = 0;
  }
}