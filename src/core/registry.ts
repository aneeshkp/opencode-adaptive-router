/**
 * Model capability registry.
 *
 * Normalizes host model listings into `ModelCard`s, assigns every card to
 * one of three tiers by blended price, and applies the hard constraints a
 * candidate must satisfy before the policy is allowed to consider it:
 *
 *   1. enabled, active-enough status, text in/out, tool support
 *      (the OpenCode agent loop cannot run without tools)
 *   2. context window fits the turn (prompt + history + output, with a
 *      safety factor) — switching models must never lose context
 *   3. cost caps and allow/deny lists from config
 *
 * Within a tier, selection is deterministic: current provider first, then
 * cheaper, then newer. Phase 3 (learned routing) will replace this ordering
 * with success-per-dollar scoring fed by telemetry.
 */

import type { RouterConfig } from "../config"
import type { ModelCard, ModelRef, Tier } from "./types"
import { modelKey, sameModel, TIERS, tierIndex } from "./types"

export interface TurnConstraints {
  /** Tokens the turn needs: prompt + session history + expected output. */
  requiredContextTokens: number
  /** Provider of the session's current model, for stickiness tie-breaks. */
  currentProviderID?: string
}

export interface RegistryRefresh {
  cards: readonly ModelCard[]
  at: number
}

function blended(input: number, output: number): number {
  // Output tokens dominate agent-loop cost (tool calls, code generation),
  // so weight them double.
  return (input + 2 * output) / 3
}

export function toCard(raw: {
  providerID: string
  id: string
  name?: string
  cost?: ReadonlyArray<{ input?: number; output?: number; cache?: { read?: number; write?: number } }>
  limit?: { context?: number; output?: number }
  capabilities?: { tools?: boolean; input?: readonly string[]; output?: readonly string[] }
  time?: { released?: number }
  status?: string
  enabled?: boolean
  variants?: ReadonlyArray<{ id?: string; settings?: { reasoningEffort?: string } }>
}): ModelCard | undefined {
  if (!raw.providerID || !raw.id) return undefined
  const input = raw.cost?.[0]?.input ?? 0
  const output = raw.cost?.[0]?.output ?? 0
  const inTypes = raw.capabilities?.input ?? ["text"]
  const outTypes = raw.capabilities?.output ?? ["text"]
  const reasoningVariants = (raw.variants ?? [])
    .filter((v) => v?.settings?.reasoningEffort !== undefined)
    .map((v) => v.id ?? "")
    .filter((id) => id.length > 0)
  return {
    ref: { providerID: raw.providerID, id: raw.id },
    name: raw.name ?? `${raw.providerID}/${raw.id}`,
    costPerMTok: { input, output, blended: blended(input, output) },
    contextTokens: raw.limit?.context ?? 0,
    outputTokens: raw.limit?.output ?? 0,
    tools: raw.capabilities?.tools === true,
    textInput: inTypes.includes("text"),
    textOutput: outTypes.includes("text"),
    released: raw.time?.released ?? 0,
    status: raw.status ?? "active",
    enabled: raw.enabled !== false,
    reasoningVariants,
  }
}

export class ModelRegistry {
  private cards: readonly ModelCard[] = []
  private refreshedAt = 0
  private readonly byKey = new Map<string, ModelCard>()

  constructor(private readonly config: RouterConfig) {}

  /** Replace the catalog. Cheap; called by the engine on a TTL. */
  refresh(cards: readonly ModelCard[], at: number): void {
    this.cards = cards
    this.refreshedAt = at
    this.byKey.clear()
    for (const card of cards) this.byKey.set(modelKey(card.ref), card)
  }

  get age(): number {
    return this.refreshedAt
  }

  needsRefresh(at: number): boolean {
    return at - this.refreshedAt > this.config.policy.registryTtlMs
  }

  get size(): number {
    return this.cards.length
  }

  cardFor(ref: ModelRef | undefined): ModelCard | undefined {
    if (!ref) return undefined
    return this.byKey.get(modelKey(ref))
  }

  tierOf(card: ModelCard): Tier {
    const { cheapMaxBlendedUsd, balancedMaxBlendedUsd } = this.config.tiers
    if (card.costPerMTok.blended <= cheapMaxBlendedUsd) return "cheap"
    if (card.costPerMTok.blended <= balancedMaxBlendedUsd) return "balanced"
    return "powerful"
  }

  /** Pinned candidate list for a tier, resolved to cards. */
  private pinnedFor(tier: Tier): ModelCard[] | undefined {
    const pinned = this.config.tiers.pinned[tier]
    if (!pinned || pinned.length === 0) return undefined
    const cards = pinned
      .map((key) => this.byKey.get(key))
      .filter((c): c is ModelCard => c !== undefined)
    return cards.length > 0 ? cards : undefined
  }

  /**
   * Hard-constraint filter. A model that fails any rule here can never be
   * routed to, regardless of policy scoring.
   */
  eligible(card: ModelCard, constraints: TurnConstraints): boolean {
    const cfg = this.config.policy
    if (!card.enabled) return false
    if (!cfg.allowStatuses.includes(card.status)) return false
    if (!card.tools) return false // agent loop requires tool calling
    if (!card.textInput || !card.textOutput) return false
    if (card.costPerMTok.output > cfg.maxOutputCostPerMTok) return false

    const key = modelKey(card.ref)
    if (cfg.allow.length > 0 && !cfg.allow.includes(key)) return false
    if (cfg.deny.includes(key)) return false

    // Context fit: never route a turn to a window that cannot hold it.
    if (card.contextTokens > 0 && constraints.requiredContextTokens > card.contextTokens) {
      return false
    }
    return true
  }

  /** All eligible candidates in a tier, ordered by the deterministic ranking. */
  candidates(tier: Tier, constraints: TurnConstraints): ModelCard[] {
    const pool = this.pinnedFor(tier) ?? this.cards.filter((c) => this.tierOf(c) === tier)
    const eligible = pool.filter((c) => this.eligible(c, constraints))
    return this.rank(eligible, constraints)
  }

  /**
   * Deterministic within-tier ranking: keep the session's provider when
   * scores are close (cheaper context replay, warm caches), then cheaper,
   * then newer releases. Tolerances make the ordering stable against tiny
   * catalog price drift.
   */
  private rank(cards: ModelCard[], constraints: TurnConstraints): ModelCard[] {
    const preferProvider = this.config.policy.preferCurrentProvider
      ? constraints.currentProviderID
      : undefined
    return [...cards].sort((a, b) => {
      if (preferProvider) {
        const aPref = a.ref.providerID === preferProvider
        const bPref = b.ref.providerID === preferProvider
        if (aPref !== bPref) return aPref ? -1 : 1
      }
      const costDelta = a.costPerMTok.blended - b.costPerMTok.blended
      if (Math.abs(costDelta) > 0.05) return costDelta
      return b.released - a.released
    })
  }

  /**
   * Fallback walk: try the requested tier, then progressively cheaper tiers
   * (never a more expensive one). Returns the best eligible card or
   * undefined when nothing satisfies the constraints.
   */
  selectWithFallback(tier: Tier, constraints: TurnConstraints): { card: ModelCard; tier: Tier } | undefined {
    const order: Tier[] = [tier]
    for (let i = tierIndex(tier) - 1; i >= 0; i--) {
      order.push(TIERS[i] as Tier)
    }
    for (const t of order) {
      const best = this.candidates(t, constraints)[0]
      if (best) return { card: best, tier: t }
    }
    return undefined
  }

  /**
   * Next tier up for escalation, skipping the model that just failed.
   */
  escalateFrom(
    failed: ModelRef,
    fromTier: Tier,
    constraints: TurnConstraints,
  ): { card: ModelCard; tier: Tier } | undefined {
    for (let i = tierIndex(fromTier) + 1; i < TIERS.length; i++) {
      const tier = TIERS[i] as Tier
      const best = this.candidates(tier, constraints).find((c) => !sameModel(c.ref, failed))
      if (best) return { card: best, tier }
    }
    return undefined
  }
}
