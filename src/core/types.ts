/**
 * Domain model for the adaptive router.
 *
 * This module is the router's contract with the world. It deliberately has
 * **no imports** — nothing here knows about OpenCode, so the routing engine
 * can be embedded behind any client that implements `RouterHost`
 * (see `core/host.ts`).
 */

/** The three routing tiers. Ordered cheap -> powerful. */
export type Tier = "cheap" | "balanced" | "powerful"

export const TIERS: readonly Tier[] = ["cheap", "balanced", "powerful"]

export function tierIndex(tier: Tier): number {
  return TIERS.indexOf(tier)
}

/** Complexity bands produced by the classifier. Ordered trivial -> hard. */
export type ComplexityBand =
  | "trivial"
  | "simple"
  | "moderate"
  | "complex"
  | "very_complex"

export const BANDS: readonly ComplexityBand[] = [
  "trivial",
  "simple",
  "moderate",
  "complex",
  "very_complex",
]

/** Coarse activity class. Drives output-size estimates and tier nudges. */
export type TaskClass =
  | "code_write"
  | "debug"
  | "refactor"
  | "test"
  | "review"
  | "architecture"
  | "explain"
  | "docs"
  | "ops"
  | "chat"

export const TASK_CLASSES: readonly TaskClass[] = [
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

/** Reference to a model on a provider. Variant is ignored for matching. */
export interface ModelRef {
  providerID: string
  id: string
}

export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (!a || !b) return false
  return a.providerID === b.providerID && a.id === b.id
}

export function modelKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}`
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

/** Deterministic features extracted from the raw prompt text. */
export interface PromptFeatures {
  charCount: number
  wordCount: number
  /** Rough token estimate (chars / 4), floored at 1. */
  estTokens: number
  codeFenceCount: number
  inlineCodeCount: number
  filePathRefCount: number
  urlCount: number
  questionCount: number
  imperativeCount: number
  bulletLineCount: number
  hasStacktrace: boolean
  hasErrorCode: boolean
  multiStepMarkers: number
  /** Identifier-ish tokens: `backticked`, camelCase, snake_case, SCREAMING. */
  identifierDensity: number
  attachmentCount: number
}

/** Session-derived signals, gathered at admission time. */
export interface SessionSnapshot {
  messageCount: number
  estTokens: number
  hasRecentError: boolean
  recentUserTexts: readonly string[]
}

/** Repository state, gathered at admission time (best effort). */
export interface RepoSnapshot {
  branch?: string
  changedFiles: number
}

/** Everything the classifier is allowed to look at. */
export interface PromptAnalysis {
  text: string
  features: PromptFeatures
  session: SessionSnapshot
  repo?: RepoSnapshot
}

/** Final classification for a turn. */
export interface Classification {
  taskClass: TaskClass
  /** 0..1 complexity score. */
  complexity: number
  band: ComplexityBand
  /** 0..1 classifier confidence. */
  confidence: number
  /** Human-readable evidence, used in logs and reports. */
  signals: readonly string[]
  /** Expected output size, used for cost estimation and context fit. */
  estOutputTokens: number
}

/* ------------------------------------------------------------------ *
 * Model registry
 * ------------------------------------------------------------------ */

/** Normalized model metadata, provider-agnostic. */
export interface ModelCard {
  ref: ModelRef
  name: string
  /** USD per million tokens. `blended` = (input + 2*output) / 3. */
  costPerMTok: { input: number; output: number; blended: number }
  contextTokens: number
  outputTokens: number
  tools: boolean
  textInput: boolean
  textOutput: boolean
  /** Epoch ms of release, 0 when unknown. */
  released: number
  /** Catalog status: "alpha" | "beta" | "deprecated" | "active". */
  status: string
  enabled: boolean
  /** Variant ids that look like reasoning-effort controls. */
  reasoningVariants: readonly string[]
}

/* ------------------------------------------------------------------ *
 * Decisions, outcomes, telemetry
 * ------------------------------------------------------------------ */

export type DecisionMode = "auto" | "advisory"

export type Verification =
  | "pending"
  | "verified"
  | "mismatch"
  | "superseded"
  | "unobserved"

/** What the router decided for one admitted prompt. */
export interface RoutingDecision {
  id: string
  sessionID: string
  at: number
  /** First N chars of the prompt, for debugging. Length gated by config. */
  promptPreview: string
  classification: Classification
  tier: Tier
  selected: ModelRef
  selectedName: string
  /** Model the session was on before this decision. */
  previousModel?: ModelRef
  /** Whether the router actually switched the session model. */
  switched: boolean
  reason: string
  mode: DecisionMode
  /** Set when this decision came from failure escalation. */
  escalatedFrom?: ModelRef
  verification: Verification
  /** The model OpenCode actually used for the turn, once observed. */
  actualModel?: ModelRef
  outcome?: TurnOutcome
}

/** Measured result of the turn, aggregated from message events. */
export interface TurnOutcome {
  at: number
  latencyMs: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  finish: string
  success: boolean
  error?: string
}

/** Aggregate stats per model. Foundation for learned routing later. */
export interface ModelStats {
  uses: number
  outcomes: number
  successes: number
  failures: number
  verified: number
  mismatches: number
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  latencyEwmaMs: number | null
}

export function emptyStats(): ModelStats {
  return {
    uses: 0,
    outcomes: 0,
    successes: 0,
    failures: 0,
    verified: 0,
    mismatches: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    latencyEwmaMs: null,
  }
}

/* ------------------------------------------------------------------ *
 * Host events (normalized)
 * ------------------------------------------------------------------ */

export type HostEvent =
  | {
      type: "message.completed"
      sessionID: string
      messageID: string
      model?: ModelRef
      tokens?: {
        input: number
        output: number
        reasoning: number
        cacheRead: number
        cacheWrite: number
      }
      costUsd?: number
      startedAt?: number
      completedAt?: number
      finish?: string
      error?: string
    }
  | {
      type: "message.error"
      sessionID: string
      messageID: string
      model?: ModelRef
      error?: string
    }
  | { type: "session.idle"; sessionID: string }
  | { type: "session.removed"; sessionID: string }
  | { type: "session.updated"; sessionID: string; model?: ModelRef }
