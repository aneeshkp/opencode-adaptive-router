import { describe, expect, test } from "vitest"
import { DEFAULT_CONFIG } from "../src/config"
import { ModelRegistry, toCard } from "../src/core/registry"
import { card, defaultCatalog } from "./fake-host"

function registry(models = defaultCatalog()) {
  const reg = new ModelRegistry(DEFAULT_CONFIG)
  reg.refresh(models, 0)
  return reg
}

const noConstraints = { requiredContextTokens: 10_000 }

describe("toCard", () => {
  test("normalizes a raw models.dev-shaped entry", () => {
    const c = toCard({
      providerID: "openai",
      id: "gpt-test",
      name: "GPT Test",
      cost: [{ input: 1, output: 4, cache: { read: 0.1, write: 1.2 } }],
      limit: { context: 128_000, output: 16_000 },
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      time: { released: 1_700_000_000_000 },
      status: "active",
      enabled: true,
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "high", settings: { reasoningEffort: "high" } },
        { id: "plain" },
      ],
    })
    expect(c).toBeDefined()
    expect(c!.costPerMTok.blended).toBeCloseTo(3)
    expect(c!.reasoningVariants).toEqual(["low", "high"])
    expect(c!.contextTokens).toBe(128_000)
  })

  test("rejects entries without identity", () => {
    expect(toCard({ providerID: "", id: "x" })).toBeUndefined()
    expect(toCard({ providerID: "p", id: "" })).toBeUndefined()
  })
})

describe("tier assignment", () => {
  test("blended cost drives tier boundaries", () => {
    const reg = registry()
    expect(reg.tierOf(card("x", "cheap", { cost: { input: 0.2, output: 0.8 } }))).toBe("cheap")
    expect(reg.tierOf(card("x", "balanced", { cost: { input: 2, output: 8 } }))).toBe("balanced")
    expect(reg.tierOf(card("x", "powerful", { cost: { input: 10, output: 40 } }))).toBe("powerful")
  })
})

describe("eligibility", () => {
  test("requires tools", () => {
    const reg = registry()
    const noTools = card("openai", "nope", { cost: { input: 0.1, output: 0.3 }, tools: false })
    expect(reg.eligible(noTools, noConstraints)).toBe(false)
  })

  test("requires enabled and allowed status", () => {
    const reg = registry()
    expect(reg.eligible(card("x", "dep", { status: "deprecated" }), noConstraints)).toBe(false)
    expect(reg.eligible(card("x", "off", { enabled: false }), noConstraints)).toBe(false)
    expect(reg.eligible(card("x", "alpha", { status: "alpha" }), noConstraints)).toBe(false)
  })

  test("rejects models whose context cannot hold the turn", () => {
    const reg = registry()
    const small = card("x", "small", { contextTokens: 8_000, cost: { input: 0.1, output: 0.3 } })
    expect(reg.eligible(small, { requiredContextTokens: 10_000 })).toBe(false)
    expect(reg.eligible(small, { requiredContextTokens: 4_000 })).toBe(true)
  })

  test("applies cost caps and deny lists", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.policy.maxOutputCostPerMTok = 10
    config.policy.deny = ["openai/gpt-sol"]
    const reg = new ModelRegistry(config)
    reg.refresh(defaultCatalog(), 0)
    expect(reg.candidates("powerful", noConstraints)).toHaveLength(0)
    expect(reg.candidates("cheap", noConstraints).map((c) => c.ref.id)).not.toContain("gpt-sol")
  })

  test("allow list restricts to listed models", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.policy.allow = ["openai/gpt-luna"]
    const reg = new ModelRegistry(config)
    reg.refresh(defaultCatalog(), 0)
    const ids = reg.candidates("cheap", noConstraints).map((c) => c.ref.id)
    expect(ids).toEqual(["gpt-luna"])
  })
})

describe("within-tier ranking", () => {
  test("prefers the session's current provider, then cheaper, then newer", () => {
    const reg = registry()
    const openai = reg.candidates("cheap", { requiredContextTokens: 10_000, currentProviderID: "openai" })
    expect(openai[0]!.ref.id).toBe("gpt-luna")

    // Without a provider preference, the cheaper google model wins.
    const any = reg.candidates("cheap", noConstraints)
    expect(any[0]!.ref.id).toBe("gemini-flash-lite")
  })
})

describe("fallback and escalation", () => {
  test("falls back to cheaper tiers when the requested tier has no candidate", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.policy.deny = ["openai/gpt-terra"]
    const reg = new ModelRegistry(config)
    reg.refresh(defaultCatalog(), 0)
    const picked = reg.selectWithFallback("balanced", noConstraints)
    expect(picked).toBeDefined()
    expect(picked!.tier).toBe("cheap")
  })

  test("returns undefined when nothing qualifies", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.policy.allow = ["openai/gpt-sol"]
    config.policy.deny = ["openai/gpt-sol"]
    const reg = new ModelRegistry(config)
    reg.refresh(defaultCatalog(), 0)
    expect(reg.selectWithFallback("powerful", noConstraints)).toBeUndefined()
  })

  test("escalation picks the next tier up and skips the failed model", () => {
    const reg = registry()
    const next = reg.escalateFrom(
      { providerID: "openai", id: "gpt-luna" },
      "cheap",
      noConstraints,
    )
    expect(next).toBeDefined()
    expect(next!.tier).toBe("balanced")
    expect(next!.card.ref.id).toBe("gpt-terra")

    // No tier above powerful.
    expect(
      reg.escalateFrom({ providerID: "openai", id: "gpt-sol" }, "powerful", noConstraints),
    ).toBeUndefined()
  })
})

describe("registry TTL", () => {
  test("needsRefresh honors the configured TTL", () => {
    const reg = registry()
    expect(reg.needsRefresh(DEFAULT_CONFIG.policy.registryTtlMs + 1)).toBe(true)
    expect(reg.needsRefresh(1)).toBe(false)
  })
})
