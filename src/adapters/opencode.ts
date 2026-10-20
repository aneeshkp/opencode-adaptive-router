/**
 * OpenCode adapter — implements `RouterHost` over the V2 plugin context.
 *
 * This is the only module (besides the plugin entry) that knows OpenCode
 * exists. Everything defensive lives here: the host's event payloads and
 * message shapes are normalized into the router's domain types, and any
 * unexpected shape degrades to "no signal" rather than an exception.
 *
 * Structural typing note: we deliberately describe the handful of ctx
 * methods we call with a local interface instead of importing SDK types,
 * so minor SDK type drift cannot break compilation. Runtime behavior is
 * verified by the engine's verification loop and the e2e test.
 */

import type {
  HostMessageSummary,
  HostSessionInfo,
  HostStorage,
  HostVcsStatus,
  PromptAdmission,
  RetryInput,
  RouterHost,
} from "../core/host"
import { toCard } from "../core/registry"
import type { HostEvent, ModelCard, ModelRef } from "../core/types"

/* ------------------------------------------------------------------ *
 * Minimal structural view of the plugin context
 * ------------------------------------------------------------------ */

export interface OpencodeCtx {
  app?: { version?: string }
  model: {
    list(): Promise<unknown>
  }
  session: {
    get(input: { sessionID: string }): Promise<unknown>
    switchModel(input: {
      sessionID: string
      model: { providerID: string; id: string }
    }): Promise<unknown>
    context(input: { sessionID: string }): Promise<unknown>
  }
  vcs: {
    get(input?: unknown): Promise<unknown>
    status(input?: unknown): Promise<unknown>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
}

/* ------------------------------------------------------------------ *
 * Defensive extraction helpers
 * ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function ref(v: unknown): ModelRef | undefined {
  if (!isRecord(v)) return undefined
  const providerID = str(v.providerID)
  const id = str(v.id) ?? str(v.model)
  if (!providerID || !id) return undefined
  return { providerID, id }
}

/** Extract a bounded error string from an unknown error value. */
function errorOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === "string") return v.slice(0, 300)
  if (isRecord(v)) {
    const s = str(v.message) ?? str(v.type)
    if (s) return s.slice(0, 300)
  }
  try {
    return JSON.stringify(v).slice(0, 300)
  } catch {
    return undefined
  }
}

/** Defensive token extraction; handles nested and flat cache fields. */
function tokensOf(v: unknown):
  | { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  | undefined {
  if (!isRecord(v)) return undefined
  const cache = isRecord(v.cache) ? v.cache : {}
  return {
    input: num(v.input) ?? 0,
    output: num(v.output) ?? 0,
    reasoning: num(v.reasoning) ?? 0,
    cacheRead: num(cache.read) ?? num(v.cacheRead) ?? 0,
    cacheWrite: num(cache.write) ?? num(v.cacheWrite) ?? 0,
  }
}

/**
 * Wire event names observed on the V2 stream (OpenCode 2.0.x). Anything
 * outside this set is logged once as an unmapped shape so drift is visible.
 */
const KNOWN_WIRE_EVENTS = new Set([
  "session.created",
  "session.renamed",
  "session.removed",
  "session.model.selected",
  "session.instructions.updated",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.aborted",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.ended",
  "session.usage.updated",
  "project.updated",
])

/**
 * Wire→domain event translator for the V2 event stream.
 *
 * The observed wire format differs from the plugin guide's examples: there
 * is no `message.completed` or `session.idle` on the wire. A turn instead
 * emits, per model call:
 *
 *   session.step.started  { assistantMessageID, agent, model, started }
 *   session.step.ended    { assistantMessageID, finish, cost, tokens }
 *
 * and for turn lifecycle:
 *
 *   session.execution.succeeded | failed | aborted (aborted unobserved,
 *   mapped defensively)
 *   session.model.selected { model }  — fires for router *and* user switches
 *
 * `step.ended` does not carry the model, so started/ended pairs are
 * correlated by message id and joined into the engine's simpler
 * `message.completed` domain event. Payloads hide in `data` (V2) or
 * `properties` (older builds); both are accepted. One wire event can yield
 * several domain events (a failed execution is both an error and a
 * turn-end). Everything is defensive: a malformed event yields nothing
 * rather than an exception.
 */
export class WireEventNormalizer {
  /** In-flight steps: message id -> what step.started told us. */
  private readonly steps = new Map<string, { model?: ModelRef; startedAt?: number }>()

  normalize(raw: unknown): HostEvent[] {
    if (!isRecord(raw)) return []
    const type = str(raw.type)
    if (!type) return []
    const data = isRecord(raw.data)
      ? (raw.data as Record<string, unknown>)
      : isRecord(raw.properties)
        ? (raw.properties as Record<string, unknown>)
        : raw
    const sessionID = str(data.sessionID)

    switch (type) {
      // A model call began; step.ended completes the picture.
      case "session.step.started": {
        if (!sessionID) return []
        const messageID = str(data.assistantMessageID) ?? ""
        this.steps.set(messageID, {
          model: ref(data.model),
          startedAt: num(data.started) ?? num(raw.created),
        })
        if (this.steps.size > 128) {
          // Defensive bound in case an `ended` never arrives.
          const oldest = this.steps.keys().next().value
          if (oldest !== undefined) this.steps.delete(oldest)
        }
        return []
      }
      // A model call finished; join with its step.started for the model.
      case "session.step.ended": {
        if (!sessionID) return []
        const messageID = str(data.assistantMessageID) ?? ""
        const step = this.steps.get(messageID)
        this.steps.delete(messageID)
        return [
          {
            type: "message.completed",
            sessionID,
            messageID,
            model: step?.model ?? ref(data.model),
            tokens: tokensOf(data.tokens),
            costUsd: num(data.cost),
            startedAt: step?.startedAt,
            completedAt: num(raw.created),
            finish: str(data.finish),
            error: errorOf(data.error),
          },
        ]
      }
      // Turn finished cleanly — the V2 name for "session went idle".
      case "session.execution.succeeded":
        return sessionID ? [{ type: "session.idle", sessionID }] : []
      // Turn failed: record the error, then finalize like any turn end.
      case "session.execution.failed":
        return sessionID
          ? [
              {
                type: "message.error",
                sessionID,
                messageID: "",
                error: errorOf(data.error) ?? "session execution failed",
              },
              { type: "session.idle", sessionID },
            ]
          : []
      // User abort: unobserved on the wire so far; finalize defensively.
      case "session.execution.aborted":
        return sessionID ? [{ type: "session.idle", sessionID }] : []
      // A model switch happened (the router's own or the user's).
      case "session.model.selected":
        return sessionID ? [{ type: "session.updated", sessionID, model: ref(data.model) }] : []
      case "session.removed":
        return sessionID ? [{ type: "session.removed", sessionID }] : []
      default:
        return []
    }
  }
}

/* ------------------------------------------------------------------ *
 * Message summary normalization
 * ------------------------------------------------------------------ */

function summarizeText(message: Record<string, unknown>): string {
  const text = str(message.text)
  if (text !== undefined) return text
  const content = message.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text)
      }
    }
    return parts.join("\n")
  }
  return ""
}

export function normalizeMessages(raw: unknown): HostMessageSummary[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.data)
      ? raw.data
      : []
  const out: HostMessageSummary[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const type = str(item.type)
    if (type === "user") {
      const text = summarizeText(item)
      out.push({ role: "user", text, estTokens: Math.max(1, Math.ceil(text.length / 4)) })
    } else if (type === "assistant") {
      const text = summarizeText(item)
      out.push({
        role: "assistant",
        text,
        estTokens: Math.max(1, Math.ceil(text.length / 4)),
        hasError: item.error !== undefined,
      })
    } else if (type === "system" || type === "synthetic" || type === "shell") {
      const text = summarizeText(item)
      out.push({ role: "system", text, estTokens: Math.max(1, Math.ceil(text.length / 4)) })
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Host implementation
 * ------------------------------------------------------------------ */

export class OpencodeHost implements RouterHost {
  private readonly controller = new AbortController()
  private readonly handlers: ((event: HostEvent) => void)[] = []
  private readonly sawEventShapes = new Set<string>()
  private readonly normalizer = new WireEventNormalizer()

  constructor(private readonly ctx: OpencodeCtx) {}

  get clientVersion(): string {
    return this.ctx.app?.version ?? "opencode-unknown"
  }

  now(): number {
    return Date.now()
  }

  log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
    const line = `[adaptive-router] ${message}`
    if (level === "error") console.error(line, data ?? "")
    else if (level === "warn") console.warn(line, data ?? "")
    else console.log(line, data ?? "")
  }

  async listModels(): Promise<readonly ModelCard[]> {
    const raw = await this.ctx.model.list()
    const list = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw.data)
        ? raw.data
        : []
    const cards: ModelCard[] = []
    for (const item of list) {
      if (!isRecord(item)) continue
      const card = toCard({
        providerID: str(item.providerID) ?? "",
        id: str(item.id) ?? "",
        name: str(item.name),
        cost: Array.isArray(item.cost) ? (item.cost as ReadonlyArray<Record<string, unknown>>) : undefined,
        limit: isRecord(item.limit) ? (item.limit as Record<string, unknown>) : undefined,
        capabilities: isRecord(item.capabilities) ? (item.capabilities as Record<string, unknown>) : undefined,
        time: isRecord(item.time) ? (item.time as Record<string, unknown>) : undefined,
        status: str(item.status),
        enabled: typeof item.enabled === "boolean" ? item.enabled : undefined,
        variants: Array.isArray(item.variants) ? (item.variants as ReadonlyArray<Record<string, unknown>>) : undefined,
      })
      if (card) cards.push(card)
    }
    return cards
  }

  async getSession(sessionID: string): Promise<HostSessionInfo | undefined> {
    try {
      const raw = await this.ctx.session.get({ sessionID })
      const info = isRecord(raw) && isRecord(raw.info) ? (raw.info as Record<string, unknown>) : isRecord(raw) ? raw : undefined
      if (!info) return undefined
      return {
        sessionID,
        parentID: str(info.parentID),
        agent: str(info.agent),
        model: ref(info.model),
      }
    } catch {
      return undefined
    }
  }

  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    await this.ctx.session.switchModel({
      sessionID,
      model: { providerID: model.providerID, id: model.id },
    })
  }

  async sessionContext(sessionID: string): Promise<readonly HostMessageSummary[]> {
    const raw = await this.ctx.session.context({ sessionID })
    return normalizeMessages(raw)
  }

  async vcsStatus(): Promise<HostVcsStatus | undefined> {
    try {
      const [infoRaw, statusRaw] = await Promise.all([
        this.ctx.vcs.get().catch(() => undefined),
        this.ctx.vcs.status().catch(() => undefined),
      ])
      let branch: string | undefined
      if (isRecord(infoRaw)) {
        const branchInfo = isRecord(infoRaw.branch) ? infoRaw.branch : undefined
        branch = branchInfo ? str(branchInfo.current) : undefined
      }
      let changedFiles = 0
      if (isRecord(statusRaw)) {
        const files = statusRaw.files
        if (Array.isArray(files)) changedFiles = files.length
      }
      return { branch, changedFiles }
    } catch {
      return undefined
    }
  }

  get storage(): HostStorage {
    const ctx = this.ctx
    return {
      async get<T>(key: string): Promise<T | undefined> {
        try {
          const value = await ctx.storage.get(key)
          return value === undefined ? undefined : (value as T)
        } catch {
          return undefined
        }
      },
      async set<T>(key: string, value: T): Promise<void> {
        await ctx.storage.set(key, value as never)
      },
    }
  }

  subscribe(handler: (event: HostEvent) => void): () => void {
    this.handlers.push(handler)
    void this.pump()
    return () => {
      const index = this.handlers.indexOf(handler)
      if (index !== -1) this.handlers.splice(index, 1)
    }
  }

  /** Start the event pump. Called by the plugin entry after subscribe. */
  private async pump(): Promise<void> {
    try {
      for await (const raw of this.ctx.event.subscribe({ signal: this.controller.signal })) {
        if (this.handlers.length === 0) continue
        let events: HostEvent[]
        try {
          events = this.normalizer.normalize(raw)
        } catch {
          continue // a malformed event must never break the pump
        }
        for (const event of events) {
          for (const handler of [...this.handlers]) handler(event)
        }
        if (events.length === 0) this.learnShape(raw)
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.log("error", "event pump crashed", error)
      }
    }
  }

  /** Log unknown wire event shapes once each, so stream drift is visible. */
  private learnShape(raw: unknown): void {
    if (!isRecord(raw)) return
    const type = str(raw.type)
    if (!type || KNOWN_WIRE_EVENTS.has(type)) return
    const data = isRecord(raw.data) ? (raw.data as Record<string, unknown>) : raw
    const shape = `${type}:${Object.keys(data).join(",")}`
    if (!this.sawEventShapes.has(shape)) {
      this.sawEventShapes.add(shape)
      this.log("debug", `unmapped event shape ${shape}`)
    }
  }

  abort(): void {
    this.controller.abort()
  }
}

export type { PromptAdmission, RetryInput }
