/**
 * Telemetry and evaluation.
 *
 * Responsibilities:
 *   - hold the bounded ring of `RoutingDecision` records
 *   - reconcile decisions against observed turn outcomes (the *verification
 *     loop*: did OpenCode actually run the turn on the selected model?)
 *   - aggregate per-model stats (success, latency, cost) — the substrate
 *     for phase-3 learned routing
 *   - track spend per session/day for the budget guard
 *   - render human-readable reports
 *
 * All mutation happens in memory; `persist()` flushes to host storage and
 * the engine calls it on a debounce.
 */

import type { RouterConfig } from "../config"
import type {
  ModelRef,
  ModelStats,
  RoutingDecision,
  TurnOutcome,
} from "./types"
import { emptyStats, modelKey, sameModel } from "./types"
import type { HostStorage } from "./host"

const RECORDS_KEY = "router/records"
const STATS_KEY = "router/stats"
const SPEND_KEY = "router/spend"

interface SpendState {
  bySession: Record<string, number>
  byDay: Record<string, number>
  total: number
}

interface PersistedShape {
  records: RoutingDecision[]
  stats: Record<string, ModelStats>
  spend: SpendState
}

function todayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function asFinite(n: unknown, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback
}

/** Defensive rehydration: persisted JSON may come from older versions. */
function hydrateDecision(raw: unknown): RoutingDecision | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const selected = r.selected as ModelRef | undefined
  if (!selected || typeof selected.providerID !== "string" || typeof selected.id !== "string") {
    return undefined
  }
  const decision: RoutingDecision = {
    id: typeof r.id === "string" ? r.id : `legacy-${Math.random().toString(36).slice(2)}`,
    sessionID: typeof r.sessionID === "string" ? r.sessionID : "unknown",
    at: asFinite(r.at),
    promptPreview: typeof r.promptPreview === "string" ? r.promptPreview : "",
    classification: (r.classification ?? {}) as RoutingDecision["classification"],
    tier: (r.tier as RoutingDecision["tier"]) ?? "balanced",
    selected,
    selectedName: typeof r.selectedName === "string" ? r.selectedName : modelKey(selected),
    previousModel: r.previousModel as ModelRef | undefined,
    switched: r.switched === true,
    reason: typeof r.reason === "string" ? r.reason : "",
    mode: r.mode === "advisory" ? "advisory" : "auto",
    escalatedFrom: r.escalatedFrom as ModelRef | undefined,
    verification:
      r.verification === "verified" ||
      r.verification === "mismatch" ||
      r.verification === "superseded" ||
      r.verification === "unobserved"
        ? (r.verification as RoutingDecision["verification"])
        : "pending",
    actualModel: r.actualModel as ModelRef | undefined,
    outcome: r.outcome as TurnOutcome | undefined,
  }
  return decision
}

export class Telemetry {
  private records: RoutingDecision[] = [] // newest first
  private stats = new Map<string, ModelStats>()
  private spend: SpendState = { bySession: {}, byDay: {}, total: 0 }
  /**
   * The decision currently executing for each session. Lives from prompt
   * admission until the session goes idle, so every assistant message in
   * the turn — including tool-call continuations — folds into it.
   */
  private active = new Map<string, RoutingDecision>()
  private dirty = false

  constructor(
    private readonly storage: HostStorage,
    private readonly config: RouterConfig,
    private readonly now: () => number,
  ) {}

  async load(): Promise<void> {
    const [recordsRaw, statsRaw, spendRaw] = await Promise.all([
      this.storage.get<unknown>(RECORDS_KEY),
      this.storage.get<unknown>(STATS_KEY),
      this.storage.get<unknown>(SPEND_KEY),
    ])
    if (Array.isArray(recordsRaw)) {
      this.records = recordsRaw
        .map(hydrateDecision)
        .filter((d): d is RoutingDecision => d !== undefined)
        .slice(0, this.config.telemetry.retain)
      // The active-decision map is memory-only: a record persisted as
      // "pending" can never settle after a restart, so mark it unobserved
      // to keep reports honest.
      for (const d of this.records) {
        if (d.verification === "pending") d.verification = "unobserved"
      }
    }
    if (typeof statsRaw === "object" && statsRaw !== null) {
      for (const [key, value] of Object.entries(statsRaw as Record<string, unknown>)) {
        if (typeof value === "object" && value !== null) {
          const v = value as Partial<ModelStats>
          this.stats.set(key, { ...emptyStats(), ...v })
        }
      }
    }
    if (typeof spendRaw === "object" && spendRaw !== null) {
      const s = spendRaw as Partial<SpendState>
      this.spend = {
        bySession: s.bySession ?? {},
        byDay: s.byDay ?? {},
        total: asFinite(s.total),
      }
    }
  }

  async persist(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const statsObj: Record<string, ModelStats> = {}
    for (const [key, value] of this.stats) statsObj[key] = value
    const payload: PersistedShape = {
      records: this.records,
      stats: statsObj,
      spend: this.spend,
    }
    await this.storage.set(RECORDS_KEY, payload.records)
    await this.storage.set(STATS_KEY, payload.stats)
    await this.storage.set(SPEND_KEY, this.spend)
  }

  markDirty(): void {
    this.dirty = true
  }

  /* ---------------- decisions ---------------- */

  recordDecision(decision: RoutingDecision): void {
    // A still-active decision for this session means the previous turn
    // never settled; mark it superseded before the new one takes over.
    const existing = this.active.get(decision.sessionID)
    if (existing && existing.verification === "pending") {
      existing.verification = "superseded"
    }
    this.active.set(decision.sessionID, decision)
    this.records.unshift(decision)
    if (this.records.length > this.config.telemetry.retain) {
      this.records.length = this.config.telemetry.retain
    }
    const stats = this.statsFor(decision.selected)
    stats.uses += 1
    this.dirty = true
  }

  /** The decision currently executing for a session, if any. */
  pendingFor(sessionID: string): RoutingDecision | undefined {
    return this.active.get(sessionID)
  }

  patchDecision(id: string, patch: Partial<RoutingDecision>): RoutingDecision | undefined {
    const decision = this.records.find((d) => d.id === id)
    if (!decision) return undefined
    Object.assign(decision, patch)
    this.dirty = true
    return decision
  }

  /* ---------------- outcomes & verification ---------------- */

  /**
   * Fold an observed completed assistant message into the pending decision
   * for its session. The first observed model settles verification; token,
   * cost, and latency figures accumulate across the turn's model calls
   * (tool-call continuations) until the session goes idle.
   */
  applyMessageCompleted(event: {
    sessionID: string
    messageID?: string
    model?: ModelRef
    tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
    costUsd?: number
    startedAt?: number
    completedAt?: number
    finish?: string
    error?: string
  }): RoutingDecision | undefined {
    const decision = this.active.get(event.sessionID)
    if (!decision) return undefined

    const now = this.now()

    // Verification is settled by the first observed model of the turn.
    if (decision.verification === "pending" && event.model) {
      if (sameModel(decision.selected, event.model)) {
        decision.verification = "verified"
        decision.actualModel = event.model
        this.statsFor(decision.selected).verified += 1
      } else {
        decision.verification = "mismatch"
        decision.actualModel = event.model
        this.statsFor(decision.selected).mismatches += 1
      }
      this.dirty = true
    }

    const t = event.tokens
    const costUsd = event.costUsd ?? 0
    const latencyMs =
      event.completedAt !== undefined && event.startedAt !== undefined
        ? Math.max(0, event.completedAt - event.startedAt)
        : event.completedAt !== undefined
          ? Math.max(0, event.completedAt - decision.at)
          : Math.max(0, now - decision.at)

    const finish = event.finish ?? "unknown"
    const failed = finish === "error" || finish === "content-filter" || event.error !== undefined

    const prev: TurnOutcome = decision.outcome ?? {
      at: now,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      finish,
      success: true,
    }
    decision.outcome = {
      at: now,
      latencyMs: Math.max(prev.latencyMs, latencyMs),
      inputTokens: prev.inputTokens + (t?.input ?? 0),
      outputTokens: prev.outputTokens + (t?.output ?? 0),
      reasoningTokens: prev.reasoningTokens + (t?.reasoning ?? 0),
      cacheReadTokens: prev.cacheReadTokens + (t?.cacheRead ?? 0),
      cacheWriteTokens: prev.cacheWriteTokens + (t?.cacheWrite ?? 0),
      costUsd: prev.costUsd + costUsd,
      finish,
      success: prev.success && !failed,
      error: event.error ?? prev.error,
    }

    this.spend.bySession[event.sessionID] =
      (this.spend.bySession[event.sessionID] ?? 0) + costUsd
    const day = todayKey(now)
    this.spend.byDay[day] = (this.spend.byDay[day] ?? 0) + costUsd
    this.spend.total += costUsd

    const stats = this.statsFor(decision.selected)
    stats.outcomes += 1
    if (decision.outcome.success) stats.successes += 1
    else stats.failures += 1
    stats.totalCostUsd += costUsd
    stats.totalInputTokens += t?.input ?? 0
    stats.totalOutputTokens += t?.output ?? 0
    const ewmaAlpha = 0.25
    stats.latencyEwmaMs =
      stats.latencyEwmaMs === null
        ? latencyMs
        : stats.latencyEwmaMs * (1 - ewmaAlpha) + latencyMs * ewmaAlpha

    this.dirty = true
    return decision
  }

  /**
   * Finalize the turn for a session (session went idle). Returns the
   * finalized decision if it never observed a completion.
   */
  finalizeSession(sessionID: string): RoutingDecision | undefined {
    const decision = this.active.get(sessionID)
    if (!decision) return undefined
    this.active.delete(sessionID)
    if (decision.verification === "pending") {
      decision.verification = "unobserved"
      this.dirty = true
      return decision
    }
    return undefined
  }

  /** Close a pending decision without a completed message (interrupt etc.). */
  abandonPending(sessionID: string, verification: "unobserved" | "superseded"): void {
    const decision = this.active.get(sessionID)
    if (!decision) return
    this.active.delete(sessionID)
    if (decision.verification === "pending") {
      decision.verification = verification
      this.dirty = true
    }
  }

  /* ---------------- queries ---------------- */

  statsFor(ref: ModelRef): ModelStats {
    const key = modelKey(ref)
    let stats = this.stats.get(key)
    if (!stats) {
      stats = emptyStats()
      this.stats.set(key, stats)
    }
    return stats
  }

  sessionSpendUsd(sessionID: string): number {
    return this.spend.bySession[sessionID] ?? 0
  }

  dailySpendUsd(at: number): number {
    return this.spend.byDay[todayKey(at)] ?? 0
  }

  get decisionCount(): number {
    return this.records.length
  }

  recentDecisions(limit: number): readonly RoutingDecision[] {
    return this.records.slice(0, limit)
  }

  /** Aggregate verification summary — the health metric of the seam. */
  verificationSummary(): { verified: number; mismatch: number; other: number; rate: number | null } {
    let verified = 0
    let mismatch = 0
    let other = 0
    for (const d of this.records) {
      if (d.verification === "verified") verified += 1
      else if (d.verification === "mismatch") mismatch += 1
      else other += 1
    }
    const settled = verified + mismatch
    return {
      verified,
      mismatch,
      other,
      rate: settled > 0 ? verified / settled : null,
    }
  }

  /* ---------------- reports ---------------- */

  reportLines(limit = 15): string[] {
    const lines: string[] = []
    lines.push("## Router report")
    const v = this.verificationSummary()
    lines.push(
      `decisions=${this.records.length} verified=${v.verified} mismatch=${v.mismatch} pending/other=${v.other}` +
        (v.rate !== null ? ` seam-verification=${(v.rate * 100).toFixed(1)}%` : ""),
    )
    const spendToday = this.dailySpendUsd(this.now())
    lines.push(
      `spend: total=$${this.spend.total.toFixed(4)} today=$${spendToday.toFixed(4)}`,
    )
    lines.push("")
    lines.push("### Recent decisions")
    for (const d of this.recentDecisions(limit)) {
      const cls = d.classification
      const outcome = d.outcome
        ? ` | ${(d.outcome.finish ?? "?")} ${d.outcome.costUsd.toFixed(4)}$ ${(d.outcome.latencyMs / 1000).toFixed(1)}s`
        : ""
      const actual = d.verification === "mismatch" && d.actualModel ? ` ACTUAL=${modelKey(d.actualModel)}` : ""
      const esc = d.escalatedFrom ? ` (escalated from ${modelKey(d.escalatedFrom)})` : ""
      lines.push(
        `- ${new Date(d.at).toISOString().slice(11, 19)} ${d.sessionID.slice(0, 8)} ` +
          `[${cls.taskClass}/${cls.band}] -> ${modelKey(d.selected)}${esc} ` +
          `(${d.verification})${outcome}${actual}`,
      )
    }
    return lines
  }

  statsLines(): string[] {
    const lines: string[] = []
    lines.push("## Router model stats")
    lines.push(
      "model | uses | outcomes | success | verified/mismatch | cost$ | in/out ktok | latency ewma",
    )
    const entries = [...this.stats.entries()].sort((a, b) => b[1].uses - a[1].uses)
    for (const [key, s] of entries) {
      if (s.uses === 0) continue
      const successRate = s.outcomes > 0 ? ((s.successes / s.outcomes) * 100).toFixed(0) : "-"
      lines.push(
        `${key} | ${s.uses} | ${s.outcomes} | ${successRate}% | ${s.verified}/${s.mismatches} | ` +
          `${s.totalCostUsd.toFixed(4)} | ${(s.totalInputTokens / 1000).toFixed(1)}/${(s.totalOutputTokens / 1000).toFixed(1)} | ` +
          `${s.latencyEwmaMs === null ? "-" : (s.latencyEwmaMs / 1000).toFixed(1) + "s"}`,
      )
    }
    return lines
  }
}
