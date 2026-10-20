/**
 * Router configuration.
 *
 * Parsed from plugin options in `opencode.jsonc`:
 *
 * ```jsonc
 * {
 *   "plugins": [
 *     {
 *       "package": "/path/to/opencode-adaptive-router",
 *       "options": { "...see below..." }
 *     }
 *   ]
 * }
 * ```
 *
 * All fields are optional; every value is validated and clamped so the
 * engine can trust the config object blindly.
 */

import type { ComplexityBand, TaskClass, Tier } from "./core/types"

export interface RouterConfig {
  /** "auto" switches models; "advisory" only logs what it would do. */
  mode: "auto" | "advisory"
  /** Skip routing for child (subagent) sessions. Recommended: true. */
  routePrimaryOnly: boolean
  /**
   * When the session model was changed by something other than the router
   * (e.g. the user ran /models), stop routing that session.
   */
  respectManualSelection: boolean
  tiers: {
    /** Max blended $/Mtok for the cheap and balanced tiers. */
    cheapMaxBlendedUsd: number
    balancedMaxBlendedUsd: number
    /** Explicit per-tier candidate lists ("provider/model" strings). */
    pinned: Partial<Record<Tier, string[]>>
  }
  /** Overrides mapping a complexity band onto a different tier. */
  bandTierOverride: Partial<Record<ComplexityBand, Tier>>
  /** Task classes that force at least the balanced tier. */
  minBalancedClasses: TaskClass[]
  policy: {
    /** Hard cap on output $/Mtok for any routed model. */
    maxOutputCostPerMTok: number
    /** Model allowlist ("provider/model"). Empty = all. */
    allow: string[]
    /** Model denylist ("provider/model"). */
    deny: string[]
    /** Prefer the session's current provider when scores tie. */
    preferCurrentProvider: boolean
    /** Context fit = (prompt + session + est output) * factor must fit. */
    contextSafetyFactor: number
    /** Reserve for the model's own output inside the context window. */
    outputReserveTokens: number
    /** Allow "alpha"/"beta" catalog statuses in addition to "active". */
    allowStatuses: string[]
    /** Model list cache TTL in ms. */
    registryTtlMs: number
  }
  escalation: {
    enabled: boolean
    /** Max in-turn escalation hops per session turn. */
    maxHops: number
    /** Delay before an escalated retry, in ms. */
    retryDelayMs: number
  }
  budget: {
    /** Soft cap: past this, route everything to the cheapest fit. */
    sessionMaxUsd: number
    dailyMaxUsd: number
  }
  telemetry: {
    /** Number of decision records retained. */
    retain: number
    /** Characters of prompt text stored per decision. 0 disables. */
    promptPreviewChars: number
    /** Persist state at most this often (ms). */
    persistDebounceMs: number
  }
  /** Collected during parsing; surfaced in logs. */
  warnings: string[]
}

export const DEFAULT_CONFIG: RouterConfig = {
  mode: "auto",
  routePrimaryOnly: true,
  respectManualSelection: true,
  tiers: {
    cheapMaxBlendedUsd: 1.5,
    balancedMaxBlendedUsd: 8,
    pinned: {},
  },
  bandTierOverride: {},
  /**
   * Classes that modify code or diagnose failures floor at balanced:
   * cheap models are for discovery and conversation (the Luna role),
   * execution stays on mid-tier models (the Terra role). Override via
   * config if your cheap models are stronger.
   */
  minBalancedClasses: ["architecture", "code_write", "debug", "refactor", "test"],
  policy: {
    maxOutputCostPerMTok: 60,
    allow: [],
    deny: [],
    preferCurrentProvider: true,
    contextSafetyFactor: 1.25,
    outputReserveTokens: 8192,
    allowStatuses: ["active", "beta"],
    registryTtlMs: 5 * 60_000,
  },
  escalation: {
    enabled: true,
    maxHops: 1,
    retryDelayMs: 500,
  },
  budget: {
    sessionMaxUsd: 10,
    dailyMaxUsd: 50,
  },
  telemetry: {
    retain: 400,
    promptPreviewChars: 120,
    persistDebounceMs: 2000,
  },
  warnings: [],
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function num(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  warn: (msg: string) => void,
  path: string,
): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warn(`${path}: expected number, got ${JSON.stringify(value)}; using ${fallback}`)
    return fallback
  }
  const clamped = Math.min(max, Math.max(min, value))
  if (clamped !== value) {
    warn(`${path}: ${value} out of range [${min}, ${max}]; clamped to ${clamped}`)
  }
  return clamped
}

function bool(value: unknown, fallback: boolean, warn: (msg: string) => void, path: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    warn(`${path}: expected boolean, got ${JSON.stringify(value)}; using ${fallback}`)
    return fallback
  }
  return value
}

function strList(value: unknown, warn: (msg: string) => void, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    warn(`${path}: expected string[]; ignoring`)
    return []
  }
  return (value as string[]).map((s) => s.trim()).filter((s) => s.length > 0)
}

const VALID_TIERS: readonly string[] = ["cheap", "balanced", "powerful"]
const VALID_BANDS: readonly string[] = [
  "trivial",
  "simple",
  "moderate",
  "complex",
  "very_complex",
]
const VALID_CLASSES: readonly string[] = [
  "code_write",
  "debug",
  "refactor",
  "test",
  "review",
  "architecture",
  "explain",
  "docs",
  "ops",
  "chat",
]

/** Parse and validate plugin options onto a complete config. */
export function parseConfig(input: unknown): RouterConfig {
  const cfg: RouterConfig = structuredClone(DEFAULT_CONFIG)
  const warn = (msg: string) => cfg.warnings.push(msg)
  if (!isRecord(input)) {
    if (input !== undefined && input !== null) warn("options: expected an object; using defaults")
    return cfg
  }

  const mode = input.mode
  if (mode !== undefined) {
    if (mode === "auto" || mode === "advisory") cfg.mode = mode
    else warn(`mode: expected "auto"|"advisory", got ${JSON.stringify(mode)}; using ${cfg.mode}`)
  }
  cfg.routePrimaryOnly = bool(input.routePrimaryOnly, cfg.routePrimaryOnly, warn, "routePrimaryOnly")
  cfg.respectManualSelection = bool(
    input.respectManualSelection,
    cfg.respectManualSelection,
    warn,
    "respectManualSelection",
  )

  if (isRecord(input.tiers)) {
    const t = input.tiers
    cfg.tiers.cheapMaxBlendedUsd = num(
      t.cheapMaxBlendedUsd, cfg.tiers.cheapMaxBlendedUsd, 0.01, 100, warn, "tiers.cheapMaxBlendedUsd")
    cfg.tiers.balancedMaxBlendedUsd = num(
      t.balancedMaxBlendedUsd, cfg.tiers.balancedMaxBlendedUsd, 0.02, 500, warn, "tiers.balancedMaxBlendedUsd")
    if (isRecord(t.pinned)) {
      for (const tier of VALID_TIERS) {
        const list = t.pinned[tier]
        if (list !== undefined) {
          const parsed = strList(list, warn, `tiers.pinned.${tier}`)
          if (parsed.length > 0) cfg.tiers.pinned[tier as Tier] = parsed
        }
      }
    }
  }

  if (isRecord(input.bandTierOverride)) {
    for (const [band, tier] of Object.entries(input.bandTierOverride)) {
      if (!VALID_BANDS.includes(band)) {
        warn(`bandTierOverride: unknown band ${band}`)
        continue
      }
      if (typeof tier !== "string" || !VALID_TIERS.includes(tier)) {
        warn(`bandTierOverride.${band}: unknown tier ${JSON.stringify(tier)}`)
        continue
      }
      cfg.bandTierOverride[band as ComplexityBand] = tier as Tier
    }
  }

  if (Array.isArray(input.minBalancedClasses)) {
    const classes: TaskClass[] = []
    for (const c of input.minBalancedClasses) {
      if (typeof c === "string" && VALID_CLASSES.includes(c)) {
        classes.push(c as TaskClass)
      } else {
        warn(`minBalancedClasses: ignoring invalid entry ${JSON.stringify(c)}`)
      }
    }
    if (classes.length > 0) cfg.minBalancedClasses = classes
    else if (input.minBalancedClasses.length > 0) {
      warn("minBalancedClasses: no valid classes; using defaults")
    }
  }

  if (isRecord(input.policy)) {
    const p = input.policy
    cfg.policy.maxOutputCostPerMTok = num(
      p.maxOutputCostPerMTok, cfg.policy.maxOutputCostPerMTok, 0.1, 10_000, warn, "policy.maxOutputCostPerMTok")
    cfg.policy.allow = strList(p.allow, warn, "policy.allow")
    cfg.policy.deny = strList(p.deny, warn, "policy.deny")
    cfg.policy.preferCurrentProvider = bool(
      p.preferCurrentProvider, cfg.policy.preferCurrentProvider, warn, "policy.preferCurrentProvider")
    cfg.policy.contextSafetyFactor = num(
      p.contextSafetyFactor, cfg.policy.contextSafetyFactor, 1, 4, warn, "policy.contextSafetyFactor")
    cfg.policy.outputReserveTokens = Math.round(
      num(p.outputReserveTokens, cfg.policy.outputReserveTokens, 1024, 1_000_000, warn, "policy.outputReserveTokens"))
    if (Array.isArray(p.allowStatuses)) {
      const statuses = p.allowStatuses.filter((s): s is string => typeof s === "string" && s.length > 0)
      if (statuses.length > 0) cfg.policy.allowStatuses = statuses
    }
    cfg.policy.registryTtlMs = Math.round(
      num(p.registryTtlMs, cfg.policy.registryTtlMs, 10_000, 3_600_000, warn, "policy.registryTtlMs"))
  }

  if (isRecord(input.escalation)) {
    const e = input.escalation
    cfg.escalation.enabled = bool(e.enabled, cfg.escalation.enabled, warn, "escalation.enabled")
    cfg.escalation.maxHops = Math.round(num(e.maxHops, cfg.escalation.maxHops, 0, 3, warn, "escalation.maxHops"))
    cfg.escalation.retryDelayMs = Math.round(
      num(e.retryDelayMs, cfg.escalation.retryDelayMs, 0, 60_000, warn, "escalation.retryDelayMs"))
  }

  if (isRecord(input.budget)) {
    const b = input.budget
    cfg.budget.sessionMaxUsd = num(b.sessionMaxUsd, cfg.budget.sessionMaxUsd, 0.1, 1000, warn, "budget.sessionMaxUsd")
    cfg.budget.dailyMaxUsd = num(b.dailyMaxUsd, cfg.budget.dailyMaxUsd, 0.1, 10_000, warn, "budget.dailyMaxUsd")
  }

  if (isRecord(input.telemetry)) {
    const t = input.telemetry
    cfg.telemetry.retain = Math.round(num(t.retain, cfg.telemetry.retain, 10, 5000, warn, "telemetry.retain"))
    cfg.telemetry.promptPreviewChars = Math.round(
      num(t.promptPreviewChars, cfg.telemetry.promptPreviewChars, 0, 2000, warn, "telemetry.promptPreviewChars"))
    cfg.telemetry.persistDebounceMs = Math.round(
      num(t.persistDebounceMs, cfg.telemetry.persistDebounceMs, 0, 60_000, warn, "telemetry.persistDebounceMs"))
  }

  return cfg
}
