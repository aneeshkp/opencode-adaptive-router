/**
 * RouterEngine — the execution and fallback controller.
 *
 * This is the component that makes routing *real* rather than advisory:
 *
 *   1. At prompt admission (before OpenCode resolves the model for the
 *      turn) it classifies the turn, picks a tier, and calls
 *      `host.switchModel` so the admitted prompt executes on the selected
 *      model with tools and full session context intact.
 *   2. During the turn it watches host events and *verifies* that the
 *      model OpenCode actually used matches the selection. Mismatches are
 *      logged loudly — they indicate a seam failure (race, manual
 *      override, or host quirk) and are counted in telemetry.
 *   3. On provider failure it may escalate one tier up and accept a retry.
 *   4. It refuses to fight the user: a manual `/models` switch disables
 *      routing for that session.
 *
 * The engine talks only to `RouterHost`, never to OpenCode directly.
 */

import { parseConfig, type RouterConfig } from "./config"
import type { PromptAdmission, RetryInput, RouterHost } from "./core/host"
import { ModelRegistry } from "./core/registry"
import { SelectionPolicy } from "./core/policy"
import { Telemetry } from "./core/telemetry"
import { classify, emptySession, extractFeatures } from "./core/analyzer"
import type {
  HostEvent,
  ModelCard,
  ModelRef,
  RoutingDecision,
  SessionSnapshot,
  TaskClass,
  Tier,
} from "./core/types"
import { modelKey, sameModel } from "./core/types"

const STATE_KEY = "router/state"
const MAX_TRACKED_SESSIONS = 200

interface EngineState {
  /** Last model the router switched each session to. */
  lastSwitch: Record<string, ModelRef>
  /** Sessions the user manually took over; routing disabled for them. */
  manual: Record<string, boolean>
  /** Sticky per-session selection so mid-session tier picks don't flap. */
  sticky: Record<string, { tier: Tier; model: ModelRef }>
  /** In-turn escalation hops per session. */
  hops: Record<string, number>
  /** Task class inferred for the session's previous turn. */
  lastClass: Record<string, TaskClass>
}

function emptyState(): EngineState {
  return { lastSwitch: {}, manual: {}, sticky: {}, hops: {}, lastClass: {} }
}

function hydrateState(raw: unknown): EngineState {
  const state = emptyState()
  if (typeof raw !== "object" || raw === null) return state
  const r = raw as Record<string, unknown>
  const asRef = (v: unknown): ModelRef | undefined =>
    typeof v === "object" && v !== null && typeof (v as ModelRef).providerID === "string" &&
      typeof (v as ModelRef).id === "string"
      ? (v as ModelRef)
      : undefined
  if (typeof r.lastSwitch === "object" && r.lastSwitch !== null) {
    for (const [sid, ref] of Object.entries(r.lastSwitch as Record<string, unknown>)) {
      const m = asRef(ref)
      if (m) state.lastSwitch[sid] = m
    }
  }
  if (typeof r.manual === "object" && r.manual !== null) {
    for (const [sid, v] of Object.entries(r.manual as Record<string, unknown>)) {
      if (v === true) state.manual[sid] = true
    }
  }
  if (typeof r.sticky === "object" && r.sticky !== null) {
    for (const [sid, v] of Object.entries(r.sticky as Record<string, unknown>)) {
      const s = v as { tier?: unknown; model?: unknown }
      const m = asRef(s.model)
      if (m && (s.tier === "cheap" || s.tier === "balanced" || s.tier === "powerful")) {
        state.sticky[sid] = { tier: s.tier, model: m }
      }
    }
  }
  if (typeof r.hops === "object" && r.hops !== null) {
    for (const [sid, v] of Object.entries(r.hops as Record<string, unknown>)) {
      if (typeof v === "number") state.hops[sid] = v
    }
  }
  if (typeof r.lastClass === "object" && r.lastClass !== null) {
    for (const [sid, v] of Object.entries(r.lastClass as Record<string, unknown>)) {
      if (typeof v === "string") state.lastClass[sid] = v as TaskClass
    }
  }
  return state
}

export class RouterEngine {
  private readonly config: RouterConfig
  private readonly registry: ModelRegistry
  private readonly policy: SelectionPolicy
  private readonly telemetry: Telemetry
  private state: EngineState = emptyState()
  private decisionCounter = 0
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private readonly unsubscribe: () => void
  private readonly warnedBudgetSessions = new Set<string>()
  private disposed = false

  constructor(
    private readonly host: RouterHost,
    options?: unknown,
  ) {
    this.config = parseConfig(options)
    this.registry = new ModelRegistry(this.config)
    this.policy = new SelectionPolicy(this.config)
    this.telemetry = new Telemetry(host.storage, this.config, () => host.now())
    this.unsubscribe = host.subscribe((event) => this.handleEvent(event))
  }

  /** Load persisted state and telemetry, and prime the model registry. */
  async init(): Promise<void> {
    await this.telemetry.load()
    const state = await this.host.storage.get<unknown>(STATE_KEY)
    this.state = hydrateState(state)
    await this.refreshRegistry()
    for (const warning of this.config.warnings) {
      this.host.log("warn", `config: ${warning}`)
    }
    this.host.log(
      "info",
      `adaptive-router ready (mode=${this.config.mode}, models=${this.registry.size}, ` +
        `client=${this.host.clientVersion})`,
    )
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer)
    void this.flush()
  }

  /* -------------------------------------------------------------- *
   * Prompt admission — the routing seam
   * -------------------------------------------------------------- */

  async handlePromptAdmission(admission: PromptAdmission): Promise<void> {
    if (this.disposed) return
    try {
      await this.routePrompt(admission)
    } catch (error) {
      // Routing must never block or break a prompt. Log and get out of the way.
      this.host.log("error", "routing failed; prompt proceeds unmodified", error)
    }
  }

  private async routePrompt(admission: PromptAdmission): Promise<void> {
    const { sessionID, text } = admission
    const now = this.host.now()

    // Slash commands (e.g. "/router report") run through the prompt hook but
    // never invoke a model, so routing them would only pollute telemetry.
    // `opencode run` submits prompts wrapped in literal quote characters;
    // strip a leading run of them so quoted commands are still recognized.
    const commandText = text.trim().replace(/^["'`]+/, "").trim()
    if (commandText.startsWith("/")) {
      this.host.log("debug", `ses=${short(sessionID)} command prompt; skipping`)
      return
    }

    const session = await this.host.getSession(sessionID)
    if (!session) {
      this.host.log("debug", `ses=${short(sessionID)} no session info; skipping`)
      return
    }
    if (this.config.routePrimaryOnly && session.parentID) {
      this.host.log("debug", `ses=${short(sessionID)} subagent session; skipping`)
      return
    }
    if (this.state.manual[sessionID]) {
      this.host.log("debug", `ses=${short(sessionID)} manually controlled; skipping`)
      return
    }

    // Detect a manual model switch since our last routing action.
    const lastSwitch = this.state.lastSwitch[sessionID]
    if (
      this.config.respectManualSelection &&
      lastSwitch &&
      session.model &&
      !sameModel(session.model, lastSwitch)
    ) {
      this.state.manual[sessionID] = true
      this.markDirty()
      this.host.log(
        "info",
        `ses=${short(sessionID)} model changed externally to ${modelKey(session.model)}; ` +
          `routing disabled for this session`,
      )
      return
    }

    // Budget guard.
    const budgetMode =
      this.telemetry.sessionSpendUsd(sessionID) > this.config.budget.sessionMaxUsd ||
      this.telemetry.dailySpendUsd(now) > this.config.budget.dailyMaxUsd
    if (budgetMode && !this.warnedBudgetSessions.has(sessionID)) {
      this.warnedBudgetSessions.add(sessionID)
      this.host.log(
        "warn",
        `ses=${short(sessionID)} over budget; forcing cheapest tier ` +
          `(session=$${this.telemetry.sessionSpendUsd(sessionID).toFixed(2)}, ` +
          `today=$${this.telemetry.dailySpendUsd(now).toFixed(2)})`,
      )
    }

    // Context signals (fault tolerant).
    const [messages, vcs] = await Promise.all([
      this.host.sessionContext(sessionID).catch(() => []),
      this.host.vcsStatus().catch(() => undefined),
    ])
    const sessionSnapshot: SessionSnapshot = summarizeSession(messages)

    // Classify.
    const features = extractFeatures(text, admission.attachmentCount)
    const analysis = {
      text,
      features,
      session: sessionSnapshot,
      repo: vcs ? { branch: vcs.branch, changedFiles: vcs.changedFiles } : undefined,
    }
    const classification = classify(analysis, {
      lastClass: this.state.lastClass[sessionID],
    })

    // Select.
    if (this.registry.needsRefresh(now)) await this.refreshRegistry()
    if (this.registry.size === 0) {
      this.host.log("warn", "no models available; not routing")
      return
    }

    const { tier, reason } = this.policy.decide({ classification, session: sessionSnapshot, budgetMode })
    const constraints = {
      requiredContextTokens: SelectionPolicy.requiredContextTokens(
        features.estTokens,
        sessionSnapshot,
        classification.estOutputTokens,
        this.config,
      ),
      currentProviderID: session.model?.providerID,
    }

    // Session stickiness: keep the same model within a tier unless it is
    // no longer eligible, so catalog drift does not flap mid-session.
    const sticky = this.state.sticky[sessionID]
    let selection: { card: ModelCard; tier: Tier } | undefined
    if (sticky && sticky.tier === tier) {
      const card = this.registry.cardFor(sticky.model)
      if (card && this.registry.eligible(card, constraints)) {
        selection = { card, tier }
      }
    }
    if (!selection) {
      selection = this.registry.selectWithFallback(tier, constraints) ?? undefined
    }
    if (!selection) {
      this.host.log(
        "warn",
        `ses=${short(sessionID)} no eligible model for tier=${tier} ` +
          `(needs ${constraints.requiredContextTokens} ctx tokens); not routing`,
      )
      return
    }

    const selected = selection.card.ref
    const switched = this.config.mode === "auto" && !sameModel(session.model, selected)
    if (switched) {
      // Record before switching: our own switch emits `session.model.selected`,
      // and the event handler must not mistake it for a manual takeover.
      this.state.lastSwitch[sessionID] = selected
      await this.host.switchModel(sessionID, selected)
    }
    this.state.sticky[sessionID] = { tier: selection.tier, model: selected }
    this.state.lastClass[sessionID] = classification.taskClass
    this.pruneState()
    this.markDirty()

    const decision: RoutingDecision = {
      id: `${now}-${++this.decisionCounter}`,
      sessionID,
      at: now,
      promptPreview: this.config.telemetry.promptPreviewChars > 0
        ? text.slice(0, this.config.telemetry.promptPreviewChars).replace(/\s+/g, " ")
        : "",
      classification,
      tier: selection.tier,
      selected,
      selectedName: selection.card.name,
      previousModel: session.model,
      switched,
      reason,
      mode: this.config.mode,
      verification: "pending",
    }
    this.telemetry.recordDecision(decision)
    this.schedulePersist()

    const fromTo = switched && session.model
      ? ` (switched from ${modelKey(session.model)})`
      : switched ? " (switched)" : ""
    this.host.log(
      "info",
      `ses=${short(sessionID)} class=${classification.taskClass} band=${classification.band} ` +
        `tier=${selection.tier} -> ${modelKey(selected)}${fromTo} [${reason}]` +
        (this.config.mode === "advisory" ? " [advisory: no switch]" : ""),
    )
  }

  /* -------------------------------------------------------------- *
   * Retry / failure escalation
   * -------------------------------------------------------------- */

  async handleRetry(input: RetryInput): Promise<void> {
    if (this.disposed || !this.config.escalation.enabled) return
    try {
      const pending = this.telemetry.pendingFor(input.sessionID)
      if (!pending || !sameModel(pending.selected, input.model)) return

      const hops = this.state.hops[input.sessionID] ?? 0
      if (hops >= this.config.escalation.maxHops) return

      // Only escalate on errors a stronger model plausibly survives:
      // rate limits, server errors, overloads, timeouts. Auth and request
      // errors mean escalation just burns money on the same failure.
      const status = input.error.status
      const transient =
        status === 429 ||
        (status !== undefined && status >= 500) ||
        /timeout|overload|rate|temporarily|unavailable/i.test(input.error.message)
      if (!transient) return

      const now = this.host.now()
      const messages = await this.host
        .sessionContext(input.sessionID)
        .catch(() => [])
      const constraints = {
        requiredContextTokens: SelectionPolicy.requiredContextTokens(
          pending.classification.estOutputTokens, // prompt itself already in history
          summarizeSession(messages),
          pending.classification.estOutputTokens,
          this.config,
        ),
        currentProviderID: input.model.providerID,
      }
      const next = this.registry.escalateFrom(input.model, pending.tier, constraints)
      if (!next) return

      this.state.lastSwitch[input.sessionID] = next.card.ref // before switch: see routePrompt
      await this.host.switchModel(input.sessionID, next.card.ref)
      this.state.hops[input.sessionID] = hops + 1
      this.state.sticky[input.sessionID] = { tier: next.tier, model: next.card.ref }
      this.telemetry.patchDecision(pending.id, {
        selected: next.card.ref,
        selectedName: next.card.name,
        tier: next.tier,
        escalatedFrom: input.model,
      })
      input.acceptRetry(this.config.escalation.retryDelayMs)
      this.schedulePersist()
      this.host.log(
        "warn",
        `ses=${short(input.sessionID)} escalating after failure ` +
          `(${input.error.type}${status ? ` ${status}` : ""}, attempt ${input.attempt}): ` +
          `${modelKey(input.model)} -> ${modelKey(next.card.ref)}`,
      )
    } catch (error) {
      this.host.log("error", "escalation failed; leaving retry decision to host", error)
    }
  }

  /* -------------------------------------------------------------- *
   * Events — verification loop
   * -------------------------------------------------------------- */

  handleEvent(event: HostEvent): void {
    if (this.disposed) return
    try {
      switch (event.type) {
        case "message.completed": {
          const decision = this.telemetry.applyMessageCompleted(event)
          if (!decision) return
          if (decision.verification === "mismatch" && decision.actualModel) {
            this.host.log(
              "warn",
              `ses=${short(event.sessionID)} SEAM MISMATCH: selected=${modelKey(decision.selected)} ` +
                `actual=${modelKey(decision.actualModel)} — turn ran on an unexpected model`,
            )
          } else if (decision.verification === "verified") {
            const o = decision.outcome
            this.host.log(
              "info",
              `ses=${short(event.sessionID)} verified ${modelKey(decision.selected)}` +
                (o ? ` finish=${o.finish} cost=$${o.costUsd.toFixed(4)} latency=${(o.latencyMs / 1000).toFixed(1)}s` : ""),
            )
          }
          this.schedulePersist()
          return
        }
        case "message.error": {
          const pending = this.telemetry.pendingFor(event.sessionID)
          if (pending) {
            this.telemetry.patchDecision(pending.id, {
              outcome: {
                at: this.host.now(),
                latencyMs: 0,
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0,
                finish: "error",
                success: false,
                error: event.error ?? "message error",
              },
            })
          }
          this.host.log("warn", `ses=${short(event.sessionID)} message error`, event.error)
          return
        }
        case "session.idle": {
          const unobserved = this.telemetry.finalizeSession(event.sessionID)
          // A decision with an outcome (e.g. a failed turn) settled fine;
          // only a truly empty turn suggests broken event mapping.
          if (unobserved && !unobserved.outcome) {
            this.host.log(
              "warn",
              `ses=${short(event.sessionID)} turn went idle without an observed completion ` +
                `(event mapping may be broken)`,
            )
          }
          delete this.state.hops[event.sessionID]
          return
        }
        case "session.removed": {
          for (const map of [
            this.state.lastSwitch,
            this.state.manual,
            this.state.sticky,
            this.state.hops,
            this.state.lastClass,
          ]) {
            delete map[event.sessionID]
          }
          this.warnedBudgetSessions.delete(event.sessionID)
          this.markDirty()
          return
        }
        case "session.updated": {
          // Defense in depth for manual takeover between prompts.
          if (!this.config.respectManualSelection || !event.model) return
          const lastSwitch = this.state.lastSwitch[event.sessionID]
          if (lastSwitch && !sameModel(event.model, lastSwitch) && !this.state.manual[event.sessionID]) {
            this.state.manual[event.sessionID] = true
            this.markDirty()
            this.host.log(
              "info",
              `ses=${short(event.sessionID)} model changed externally to ${modelKey(event.model)}; ` +
                `routing disabled for this session`,
            )
          }
          return
        }
      }
    } catch (error) {
      this.host.log("error", "event handling failed", error)
    }
  }

  /* -------------------------------------------------------------- *
   * Introspection
   * -------------------------------------------------------------- */

  /** The decision currently executing for a session, if any. */
  pendingDecisionFor(sessionID: string): RoutingDecision | undefined {
    return this.telemetry.pendingFor(sessionID)
  }

  /* -------------------------------------------------------------- *
   * Commands
   * -------------------------------------------------------------- */

  runCommand(arg: string): string {
    const command = arg.trim().toLowerCase()
    if (command === "stats") return this.telemetry.statsLines().join("\n")
    if (command === "status") return this.statusLines().join("\n")
    return this.telemetry.reportLines().join("\n")
  }

  private statusLines(): string[] {
    const lines = ["## Router status"]
    lines.push(`mode=${this.config.mode} models=${this.registry.size} client=${this.host.clientVersion}`)
    lines.push(
      `tiers: cheap<=$${this.config.tiers.cheapMaxBlendedUsd}/Mtok blended, ` +
        `balanced<=$${this.config.tiers.balancedMaxBlendedUsd}/Mtok, powerful=rest`,
    )
    const v = this.telemetry.verificationSummary()
    lines.push(
      `seam verification: ${v.verified} verified / ${v.mismatch} mismatch` +
        (v.rate !== null ? ` (${(v.rate * 100).toFixed(1)}%)` : ""),
    )
    lines.push(`tracked sessions: ${Object.keys(this.state.lastSwitch).length}`)
    return lines
  }

  /* -------------------------------------------------------------- *
   * Plumbing
   * -------------------------------------------------------------- */

  private async refreshRegistry(): Promise<void> {
    try {
      const cards = await this.host.listModels()
      this.registry.refresh(cards, this.host.now())
    } catch (error) {
      this.host.log("warn", "model list refresh failed; using previous catalog", error)
    }
  }

  private pruneState(): void {
    for (const map of [
      this.state.lastSwitch,
      this.state.manual,
      this.state.sticky,
      this.state.hops,
      this.state.lastClass,
    ]) {
      const keys = Object.keys(map)
      if (keys.length > MAX_TRACKED_SESSIONS) {
        for (const key of keys.slice(0, keys.length - MAX_TRACKED_SESSIONS)) {
          delete map[key]
        }
      }
    }
  }

  private markDirty(): void {
    this.telemetry.markDirty()
  }

  private schedulePersist(): void {
    this.markDirty()
    if (this.config.telemetry.persistDebounceMs === 0) {
      void this.flush()
      return
    }
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      void this.flush()
    }, this.config.telemetry.persistDebounceMs)
  }

  private async flush(): Promise<void> {
    try {
      await this.telemetry.persist()
      await this.host.storage.set(STATE_KEY, this.state)
    } catch (error) {
      this.host.log("warn", "persist failed", error)
    }
  }
}

/* ------------------------------------------------------------------ */

function short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function summarizeSession(
  messages: ReadonlyArray<{ role: string; text: string; estTokens: number; hasError?: boolean }>,
): SessionSnapshot {
  if (messages.length === 0) return emptySession()
  let estTokens = 0
  let hasRecentError = false
  const recentUserTexts: string[] = []
  const recentWindow = messages.slice(-20)
  for (const message of recentWindow) {
    estTokens += message.estTokens
    if (message.hasError) hasRecentError = true
    if (message.role === "user" && message.text) recentUserTexts.push(message.text)
  }
  // Older history still consumes context; approximate the remainder.
  const older = messages.slice(0, Math.max(0, messages.length - 20))
  for (const message of older) estTokens += message.estTokens
  return {
    messageCount: messages.length,
    estTokens,
    hasRecentError,
    recentUserTexts: recentUserTexts.slice(-3),
  }
}

