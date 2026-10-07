export type NotificationEvent =
  "idle" | "permission" | "question" | "error" | "user-presence";
export type WorkerKind = "stop" | "permission" | "question" | "user-presence";
export type SignalName = "user-presence";
export type DeliveryBackend = "fishaudio" | "bark";

export interface HookEvent {
  session_id?: unknown;
  turn_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  model?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: unknown;
  last_assistant_message?: unknown;
  source?: unknown;
  stop_hook_active?: unknown;
  [key: string]: unknown;
}

export interface TurnMeta {
  sessionId: string;
  turnId: string;
  startedAt: number;
  currentTask?: string;
  cwd?: string;
}

export interface EvidenceRecord {
  eventName: string;
  occurredAt: number;
  action?: string;
  changedFiles?: string[];
  validation?: string;
  pendingAction?: string;
  lastAssistantMessage?: string;
}

export interface WorkerJob {
  kind: WorkerKind;
  eventId: string;
  sessionId: string;
  turnId: string;
  token: string;
  createdAt: number;
  dueAt: number;
  pendingAction?: string;
}

export interface SummaryContext {
  language: string;
  trigger: WorkerKind;
  session: {
    id: string;
    rootOnly: true;
  };
  state: {
    durationMs?: number;
    currentTask?: string;
    changedFiles?: string[];
    recentActions?: string[];
    validation?: string;
    pendingAction?: string;
    errorMessage?: string;
  };
  recentMessages?: string[];
}

export interface SummaryResult {
  event: NotificationEvent;
  text: string | null;
  actionRequired: boolean;
}

export interface DeliveryPayload {
  event: NotificationEvent;
  text: string;
  eventId: string;
  sessionId: string;
  turnId: string;
  token: string;
  kind: WorkerKind;
  createdAt: number;
}

export interface SpawnedJob {
  job: WorkerJob;
  path: string;
}
