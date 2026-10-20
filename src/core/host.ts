/**
 * The seam between the routing engine and its host client.
 *
 * The engine (analyzer, policy, telemetry, execution control) talks only to
 * this interface. OpenCode is one implementation (`adapters/opencode.ts`);
 * any other client that can list models, switch a session's model, expose
 * session context, and emit turn events can host the same engine.
 */

import type { HostEvent, ModelCard, ModelRef } from "./types"

export interface HostSessionInfo {
  sessionID: string
  /** Present when this session is a child (subagent) session. */
  parentID?: string
  agent?: string
  /** The model the session is currently set to, if any. */
  model?: ModelRef
}

export interface HostMessageSummary {
  role: "user" | "assistant" | "system" | "other"
  text: string
  estTokens: number
  hasError?: boolean
}

export interface HostVcsStatus {
  branch?: string
  changedFiles: number
}

export interface HostStorage {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
}

/** A prompt being admitted to a session, at the moment hooks can still edit it. */
export interface PromptAdmission {
  sessionID: string
  text: string
  attachmentCount: number
  /** Replace the prompt text. Phase 1 never rewrites; kept for the optimizer. */
  setText(text: string): void
}

/** A provider failure offered to the router before a retry is scheduled. */
export interface RetryInput {
  sessionID: string
  model: ModelRef
  /** Physical attempt number under consideration; the initial request is 1. */
  attempt: number
  error: { type: string; message: string; status?: number }
  acceptRetry(delayMs: number): void
  vetoRetry(): void
}

export interface RouterHost {
  /** Host client version string, for logs. */
  readonly clientVersion: string
  now(): number
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void

  /** All models currently available at this location. */
  listModels(): Promise<readonly ModelCard[]>
  getSession(sessionID: string): Promise<HostSessionInfo | undefined>
  /**
   * Point the session at a model for subsequent requests. This is the
   * execution seam: called at prompt-admission time, before the admitted
   * prompt is picked up by the session engine and model resolution runs.
   */
  switchModel(sessionID: string, model: ModelRef): Promise<void>
  /** Recent session history, oldest first. Cheap approximation is fine. */
  sessionContext(sessionID: string): Promise<readonly HostMessageSummary[]>
  vcsStatus(): Promise<HostVcsStatus | undefined>
  storage: HostStorage
  /** Subscribe to normalized host events. Returns an unsubscribe function. */
  subscribe(handler: (event: HostEvent) => void): () => void
}
