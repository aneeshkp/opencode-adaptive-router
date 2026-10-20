/**
 * Golden-set benchmark: measures the router against the labeled dataset.
 *
 *   classification accuracy  — does the rule-based classifier assign the
 *                              labeled task class and tier?
 *   routing latency          — p50/p95/max of classify + policy.decide
 *   cost simulation          — $ per 1000 turns for always-cheap,
 *                              always-balanced, always-powerful, and the
 *                              adaptive router, using live catalog prices
 *
 * `npm test` runs the accuracy/latency assertions (the golden gates).
 * `npm run bench` additionally writes docs/benchmarks/*.svg and
 * results.json (BENCH_CHARTS=1), which the README embeds.
 *
 * Methodology notes:
 *   - every prompt is classified against an empty session, so
 *     session-continuation signals are not exercised;
 *   - tier correctness is what routing acts on, so it is gated more
 *     tightly than class correctness;
 *   - the cost simulation charges each strategy the same input size
 *     (prompt estimate + measured system overhead) and the classifier's
 *     output estimate — it models spend, it does not measure it.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parseConfig } from "../src/config"
import { classify, emptySession, extractFeatures } from "../src/core/analyzer"
import { SelectionPolicy } from "../src/core/policy"
import type { Tier } from "../src/core/types"
import { DATASET } from "./dataset"
import { hbarChart, vbarChart } from "./svg"

const policy = new SelectionPolicy(parseConfig(undefined))

function route(text: string): { taskClass: string; band: string; tier: Tier; estOutputTokens: number; estInputTokens: number } {
  const analysis = { text, features: extractFeatures(text), session: emptySession() }
  const classification = classify(analysis)
  const { tier } = policy.decide({ classification, session: emptySession(), budgetMode: false })
  return {
    taskClass: classification.taskClass,
    band: classification.band,
    tier,
    estOutputTokens: classification.estOutputTokens,
    estInputTokens: analysis.features.estTokens,
  }
}

const routed = DATASET.map((p) => ({ ...p, ...route(p.text) }))

const classHits = routed.filter((p) => p.taskClass === p.expectedClass).length
const tierHits = routed.filter((p) => p.tier === p.expectedTier).length
const classAccuracy = classHits / routed.length
const tierAccuracy = tierHits / routed.length

function perClassAccuracy(): { label: string; value: number; display: string }[] {
  return [...new Set(DATASET.map((p) => p.expectedClass))].map((cls) => {
    const rows = routed.filter((p) => p.expectedClass === cls)
    const hits = rows.filter((p) => p.taskClass === p.expectedClass).length
    const acc = hits / rows.length
    return { label: cls, value: acc, display: `${(acc * 100).toFixed(0)}%` }
  })
}

function perTierAccuracy(): { label: string; value: number; display: string }[] {
  const tiers: Tier[] = ["cheap", "balanced", "powerful"]
  return tiers.map((tier) => {
    const rows = routed.filter((p) => p.expectedTier === tier)
    const hits = rows.filter((p) => p.tier === p.expectedTier).length
    const acc = rows.length === 0 ? 1 : hits / rows.length
    return { label: tier, value: acc, display: `${(acc * 100).toFixed(0)}%` }
  })
}

/* ------------------------- latency measurement ------------------------ */

const LATENCY_ROUNDS = 25

const latency = (() => {
  for (const p of DATASET) route(p.text) // warmup
  const samples: number[] = []
  for (let round = 0; round < LATENCY_ROUNDS; round++) {
    for (const p of DATASET) {
      const t0 = performance.now()
      route(p.text)
      samples.push(performance.now() - t0)
    }
  }
  samples.sort((a, b) => a - b)
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]
  return { p50: at(0.5), p95: at(0.95), max: samples[samples.length - 1]!, samples: samples.length }
})()

/* --------------------------- cost simulation -------------------------- */

// Live catalog prices for the pinned tier models (USD per Mtok).
const TIER_PRICES: Record<Tier, { model: string; input: number; output: number }> = {
  cheap: { model: "openai/gpt-6-luna", input: 0.1, output: 0.5 },
  balanced: { model: "openai/gpt-5.6-terra", input: 2, output: 12 },
  powerful: { model: "openai/gpt-6.1-sol", input: 2, output: 10 },
}
// Measured on a live turn: the agent's system prompt + tool schemas add
// roughly 4k input tokens to every call regardless of prompt size.
const SYSTEM_TOKENS = 4000

function costPer1000Turns(tierFor: (prompt: (typeof routed)[number]) => Tier): number {
  let total = 0
  for (const p of routed) {
    const price = TIER_PRICES[tierFor(p)]
    const input = p.estInputTokens + SYSTEM_TOKENS
    total += (input / 1e6) * price.input + (p.estOutputTokens / 1e6) * price.output
  }
  return total * 1000
}

const cost = {
  alwaysCheap: costPer1000Turns(() => "cheap"),
  alwaysBalanced: costPer1000Turns(() => "balanced"),
  alwaysPowerful: costPer1000Turns(() => "powerful"),
  adaptiveRouter: costPer1000Turns((p) => p.tier),
}

/* ------------------------------ assertions ---------------------------- */

describe("golden set: classification accuracy", () => {
  it("class accuracy is at least 75%", () => {
    expect(classAccuracy).toBeGreaterThanOrEqual(0.75)
  })

  it("tier accuracy is at least 85%", () => {
    expect(tierAccuracy).toBeGreaterThanOrEqual(0.85)
  })

  it("every class is at least 50% correct", () => {
    for (const row of perClassAccuracy()) {
      expect(row.value, `class ${row.label}`).toBeGreaterThanOrEqual(0.5)
    }
  })
})

describe("golden set: latency", () => {
  it("p95 routing decision latency stays under 2ms", () => {
    expect(latency.p95).toBeLessThan(2)
  })
})

describe("golden set: cost simulation", () => {
  it("adaptive routing costs less than always-balanced and always-powerful", () => {
    expect(cost.adaptiveRouter).toBeLessThan(cost.alwaysBalanced)
    expect(cost.adaptiveRouter).toBeLessThan(cost.alwaysPowerful)
  })
})

/* ---------------------------- artifact write --------------------------- */

const writeCharts = process.env.BENCH_CHARTS === "1"

it.skipIf(!writeCharts)("writes benchmark charts and results", () => {
  const dir = fileURLToPath(new URL("../docs/benchmarks/", import.meta.url))
  mkdirSync(dir, { recursive: true })

  writeFileSync(
    `${dir}/class-accuracy.svg`,
    hbarChart({
      title: "Task-class accuracy by class",
      subtitle: `golden set, n=${routed.length} hand-labeled prompts · rule-based classifier, empty session`,
      bars: [
        { label: "overall", value: classAccuracy, display: `${(classAccuracy * 100).toFixed(1)}%` },
        ...perClassAccuracy().sort((a, b) => a.value - b.value),
      ],
      maxValue: 1,
    }),
  )

  writeFileSync(
    `${dir}/tier-accuracy.svg`,
    hbarChart({
      title: "Tier accuracy by expected tier",
      subtitle: "the decision routing acts on — code classes floor at balanced, budget forces cheap",
      bars: [
        { label: "overall", value: tierAccuracy, display: `${(tierAccuracy * 100).toFixed(1)}%` },
        ...perTierAccuracy(),
      ],
      maxValue: 1,
    }),
  )

  const usd = (n: number) => `$${n.toFixed(2)}`
  writeFileSync(
    `${dir}/cost-simulation.svg`,
    vbarChart({
      title: "Simulated spend per 1000 turns",
      subtitle: `same inputs for every strategy · tier models at live catalog prices · +${SYSTEM_TOKENS} system tokens/turn`,
      unit: "USD per 1000 turns",
      bars: [
        { label: "always luna", value: cost.alwaysCheap, display: usd(cost.alwaysCheap), note: "cheap tier", color: "#94a3b8" },
        { label: "adaptive router", value: cost.adaptiveRouter, display: usd(cost.adaptiveRouter), note: "per-turn tier", color: "#0f766e" },
        { label: "always terra", value: cost.alwaysBalanced, display: usd(cost.alwaysBalanced), note: "balanced tier", color: "#3b82f6" },
        { label: "always sol", value: cost.alwaysPowerful, display: usd(cost.alwaysPowerful), note: "powerful tier", color: "#7c3aed" },
      ],
    }),
  )

  const us = (ms: number) => `${Math.round(ms * 1000)}µs`
  writeFileSync(
    `${dir}/latency.svg`,
    vbarChart({
      title: "Routing decision latency",
      subtitle: `classify + policy.decide · ${latency.samples} samples over ${LATENCY_ROUNDS} rounds · node, cold regexes warmed`,
      unit: "milliseconds",
      bars: [
        { label: "p50", value: latency.p50, display: us(latency.p50) },
        { label: "p95", value: latency.p95, display: us(latency.p95) },
        { label: "max", value: latency.max, display: us(latency.max), color: "#f59e0b" },
      ],
    }),
  )

  writeFileSync(
    `${dir}/results.json`,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        datasetSize: routed.length,
        classAccuracy: { overall: classAccuracy, perClass: Object.fromEntries(perClassAccuracy().map((r) => [r.label, r.value])) },
        tierAccuracy: { overall: tierAccuracy, perTier: Object.fromEntries(perTierAccuracy().map((r) => [r.label, r.value])) },
        latencyMs: { p50: latency.p50, p95: latency.p95, max: latency.max, samples: latency.samples },
        costSimulation: {
          unit: "USD per 1000 turns",
          systemTokensPerTurn: SYSTEM_TOKENS,
          tierPrices: TIER_PRICES,
          strategies: cost,
        },
        disagreements: routed
          .filter((p) => p.taskClass !== p.expectedClass || p.tier !== p.expectedTier)
          .map((p) => ({
            prompt: p.text.slice(0, 80),
            expected: `${p.expectedClass}/${p.expectedTier}`,
            actual: `${p.taskClass}/${p.band}/${p.tier}`,
          })),
      },
      null,
      2,
    )}\n`,
  )
})
