/**
 * Test fixtures: a fake RouterHost and model catalog helpers.
 */

import type {
  HostMessageSummary,
  HostSessionInfo,
  HostStorage,
  HostVcsStatus,
  RouterHost,
} from "../src/core/host"
import type { HostEvent, ModelCard, ModelRef } from "../src/core/types"

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error"
  message: string
}

export function card(
  providerID: string,
  id: string,
  overrides: Partial<ModelCard> & { cost?: { input: number; output: number } } = {},
): ModelCard {
  const input = overrides.cost?.input ?? 1
  const output = overrides.cost?.output ?? 3
  return {
    ref: { providerID, id },
    name: overrides.name ?? `${providerID}/${id}`,
    costPerMTok: {
      input,
      output,
      blended: (input + 2 * output) / 3,
    },
    contextTokens: overrides.contextTokens ?? 200_000,
    outputTokens: overrides.outputTokens ?? 32_000,
    tools: overrides.tools ?? true,
    textInput: overrides.textInput ?? true,
    textOutput: overrides.textOutput ?? true,
    released: overrides.released ?? Date.parse("2026-01-01"),
    status: overrides.status ?? "active",
    enabled: overrides.enabled ?? true,
    reasoningVariants: overrides.reasoningVariants ?? [],
  }
}

/**
 * A tiered catalog mirroring the user's OpenAI lineup plus cross-provider
 * candidates, so provider stickiness and tier boundaries are exercised.
 */
export function defaultCatalog(): ModelCard[] {
  return [
    card("openai", "gpt-luna", { cost: { input: 0.2, output: 0.8 } }),
    card("google-vertex", "gemini-flash-lite", { cost: { input: 0.1, output: 0.5 }, released: Date.parse("2026-02-01") }),
    card("openai", "gpt-terra", { cost: { input: 2, output: 8 } }),
    card("openai", "gpt-sol", { cost: { input: 10, output: 40 } }),
    card("anthropic", "claude-opus-5", { cost: { input: 5, output: 25 }, released: Date.parse("2026-03-01") }),
    card("openai", "no-tools-luna", { cost: { input: 0.1, output: 0.3 }, tools: false }),
    card("openai", "tiny-ctx", { cost: { input: 0.1, output: 0.3 }, contextTokens: 4_096 }),
    card("openai", "deprecated-luna", { cost: { input: 0.1, output: 0.3 }, status: "deprecated" }),
  ]
}

export class FakeHost implements RouterHost {
  clientVersion = "test-1.0"
  models: ModelCard[]
  sessions = new Map<string, HostSessionInfo & { model?: ModelRef }>()
  messages = new Map<string, HostMessageSummary[]>()
  switchCalls: Array<{ sessionID: string; model: ModelRef }> = []
  logs: LogEntry[] = []
  clock = Date.parse("2026-10-20T10:00:00Z")
  private handlers: ((event: HostEvent) => void)[] = []
  private store = new Map<string, unknown>()

  constructor(models: ModelCard[] = defaultCatalog()) {
    this.models = models
  }

  now(): number {
    return this.clock
  }

  tick(ms: number): void {
    this.clock += ms
  }

  log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.logs.push({ level, message })
  }

  warnings(): LogEntry[] {
    return this.logs.filter((l) => l.level === "warn" || l.level === "error")
  }

  async listModels(): Promise<readonly ModelCard[]> {
    return this.models
  }

  async getSession(sessionID: string): Promise<HostSessionInfo | undefined> {
    return this.sessions.get(sessionID)
  }

  addSession(sessionID: string, info: Partial<HostSessionInfo & { model?: ModelRef }> = {}): void {
    this.sessions.set(sessionID, { sessionID, parentID: undefined, agent: "build", ...info })
  }

  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    this.switchCalls.push({ sessionID, model })
    const session = this.sessions.get(sessionID)
    if (session) session.model = model
  }

  async sessionContext(sessionID: string): Promise<readonly HostMessageSummary[]> {
    return this.messages.get(sessionID) ?? []
  }

  setMessages(sessionID: string, messages: HostMessageSummary[]): void {
    this.messages.set(sessionID, messages)
  }

  async vcsStatus(): Promise<HostVcsStatus | undefined> {
    return { branch: "main", changedFiles: 0 }
  }

  get storage(): HostStorage {
    return {
      get: async <T>(key: string) => (this.store.has(key) ? (this.store.get(key) as T) : undefined),
      set: async <T>(key: string, value: T) => {
        this.store.set(key, value)
      },
    }
  }

  subscribe(handler: (event: HostEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler)
    }
  }

  emit(event: HostEvent): void {
    for (const handler of [...this.handlers]) handler(event)
  }

  /** Convenience: emit a completed assistant message for a turn. */
  emitCompleted(
    sessionID: string,
    model: ModelRef,
    overrides: Partial<{
      inputTokens: number
      outputTokens: number
      costUsd: number
      finish: string
      startedAt: number
      completedAt: number
      error: string
    }> = {},
  ): void {
    this.emit({
      type: "message.completed",
      sessionID,
      messageID: `msg-${Math.random().toString(36).slice(2, 8)}`,
      model,
      tokens: {
        input: overrides.inputTokens ?? 500,
        output: overrides.outputTokens ?? 100,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      costUsd: overrides.costUsd ?? 0.001,
      startedAt: overrides.startedAt ?? this.clock - 1000,
      completedAt: overrides.completedAt ?? this.clock,
      finish: overrides.finish ?? "stop",
      error: overrides.error,
    })
  }
}
