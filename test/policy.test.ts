import { describe, expect, test } from "vitest"
import { DEFAULT_CONFIG, parseConfig } from "../src/config"
import { SelectionPolicy } from "../src/core/policy"
import { emptySession } from "../src/core/analyzer"
import type { Classification } from "../src/core/types"

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    taskClass: "explain",
    complexity: 0.5,
    band: "moderate",
    confidence: 0.6,
    signals: [],
    estOutputTokens: 1200,
    ...overrides,
  }
}

describe("SelectionPolicy.decide", () => {
  const policy = new SelectionPolicy(DEFAULT_CONFIG)

  test("maps bands onto tiers", () => {
    expect(policy.decide({ classification: classification({ band: "trivial" }), session: emptySession(), budgetMode: false }).tier).toBe("cheap")
    expect(policy.decide({ classification: classification({ band: "simple" }), session: emptySession(), budgetMode: false }).tier).toBe("cheap")
    expect(policy.decide({ classification: classification({ band: "moderate" }), session: emptySession(), budgetMode: false }).tier).toBe("balanced")
    expect(policy.decide({ classification: classification({ band: "complex" }), session: emptySession(), budgetMode: false }).tier).toBe("powerful")
    expect(policy.decide({ classification: classification({ band: "very_complex" }), session: emptySession(), budgetMode: false }).tier).toBe("powerful")
  })

  test("architecture class is raised to at least balanced", () => {
    const d = policy.decide({
      classification: classification({ taskClass: "architecture", band: "simple" }),
      session: emptySession(),
      budgetMode: false,
    })
    expect(d.tier).toBe("balanced")
    expect(d.reason).toContain("architecture")
  })

  test("budget mode forces the cheapest tier", () => {
    const d = policy.decide({
      classification: classification({ band: "very_complex" }),
      session: emptySession(),
      budgetMode: true,
    })
    expect(d.tier).toBe("cheap")
    expect(d.reason).toContain("budget")
  })

  test("band overrides win over defaults", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.bandTierOverride = { moderate: "powerful" }
    const p = new SelectionPolicy(config)
    expect(
      p.decide({ classification: classification({ band: "moderate" }), session: emptySession(), budgetMode: false }).tier,
    ).toBe("powerful")
  })

  test("reason includes band and complexity", () => {
    const d = policy.decide({ classification: classification(), session: emptySession(), budgetMode: false })
    expect(d.reason).toContain("band=moderate")
    expect(d.reason).toContain("complexity=0.50")
  })
})

describe("requiredContextTokens", () => {
  test("scales session + prompt + output with the safety factor", () => {
    const tokens = SelectionPolicy.requiredContextTokens(
      1000, // prompt
      { messageCount: 5, estTokens: 10_000, hasRecentError: false, recentUserTexts: [] },
      2000, // est output
      DEFAULT_CONFIG,
    )
    // (1000 + 10000 + 2000 system reserve + 2000 output) * 1.25 + 8192
    expect(tokens).toBe(Math.round(15_000 * 1.25 + 8192))
  })
})

describe("parseConfig", () => {
  test("defaults on undefined options", () => {
    const cfg = parseConfig(undefined)
    expect(cfg.mode).toBe("auto")
    expect(cfg.warnings).toHaveLength(0)
  })

  test("clamps out-of-range numbers and warns", () => {
    const cfg = parseConfig({ budget: { sessionMaxUsd: -5 }, telemetry: { retain: 1e9 } })
    expect(cfg.budget.sessionMaxUsd).toBeGreaterThanOrEqual(0.1)
    expect(cfg.telemetry.retain).toBeLessThanOrEqual(5000)
    expect(cfg.warnings.length).toBeGreaterThan(0)
  })

  test("rejects bad enums and keeps defaults", () => {
    const cfg = parseConfig({ mode: "yolo", bandTierOverride: { moderate: "ultra" } })
    expect(cfg.mode).toBe("auto")
    expect(cfg.bandTierOverride).toEqual({})
    expect(cfg.warnings.length).toBe(2)
  })

  test("parses pinned tiers and class lists", () => {
    const cfg = parseConfig({
      tiers: { pinned: { cheap: ["openai/gpt-luna"] } },
      minBalancedClasses: ["review", "bogus"],
    })
    expect(cfg.tiers.pinned.cheap).toEqual(["openai/gpt-luna"])
    expect(cfg.minBalancedClasses).toEqual(["review"])
    expect(cfg.warnings.length).toBe(1)
  })
})
