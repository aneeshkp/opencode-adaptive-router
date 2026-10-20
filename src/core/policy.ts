/**
 * Model selection policy.
 *
 * Phase 1 policy is a deterministic mapping:
 *
 *   complexity band  ->  tier          (with config overrides)
 *   task class       ->  tier nudges   (e.g. architecture >= balanced)
 *   budget exceeded  ->  cheapest tier that still fits
 *
 * The `PolicyDecision` carries a human-readable reason and the considered
 * alternatives so every routing choice is auditable. Phase 3 will swap the
 * tier mapping for success-per-dollar scoring over telemetry while keeping
 * this interface identical.
 */

import type { RouterConfig } from "../config"
import type { Classification, ComplexityBand, SessionSnapshot, Tier } from "./types"
import { tierIndex } from "./types"

const BAND_TIER: Record<ComplexityBand, Tier> = {
  trivial: "cheap",
  simple: "cheap",
  moderate: "balanced",
  complex: "powerful",
  very_complex: "powerful",
}

export interface PolicyInput {
  classification: Classification
  session: SessionSnapshot
  /** True when session or daily spend is over budget. */
  budgetMode: boolean
}

export interface PolicyDecision {
  tier: Tier
  reason: string
}

function maxTier(a: Tier, b: Tier): Tier {
  return tierIndex(a) >= tierIndex(b) ? a : b
}

export class SelectionPolicy {
  constructor(private readonly config: RouterConfig) {}

  /** Required tier for this turn, before constraint fallback. */
  decide(input: PolicyInput): PolicyDecision {
    const { classification } = input
    const band = classification.band

    let tier = this.config.bandTierOverride[band] ?? BAND_TIER[band]
    const reasons: string[] = [`band=${band}`]

    if (this.config.minBalancedClasses.includes(classification.taskClass)) {
      const raised = maxTier(tier, "balanced")
      if (raised !== tier) reasons.push(`class=${classification.taskClass} requires balanced+`)
      tier = raised
    }

    if (input.budgetMode) {
      tier = "cheap"
      reasons.push("budget mode: forcing cheapest tier")
    }

    reasons.push(
      `complexity=${classification.complexity.toFixed(2)}`,
      `confidence=${classification.confidence.toFixed(2)}`,
    )
    return { tier, reason: reasons.join(", ") }
  }

  /** Estimated input tokens for the turn: history + prompt + system reserve. */
  static requiredContextTokens(
    promptEstTokens: number,
    session: SessionSnapshot,
    estOutputTokens: number,
    config: RouterConfig,
  ): number {
    const systemReserve = 2000
    return Math.round(
      (session.estTokens + promptEstTokens + systemReserve + estOutputTokens) *
        config.policy.contextSafetyFactor +
        config.policy.outputReserveTokens,
    )
  }
}
