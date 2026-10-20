import { describe, expect, test } from "vitest"
import { DEFAULT_CONFIG } from "../src/config"
import { Telemetry } from "../src/core/telemetry"
import type { RoutingDecision } from "../src/core/types"
import type { HostStorage } from "../src/core/host"
import type { ModelRef } from "../src/core/types"

const luna: ModelRef = { providerID: "openai", id: "gpt-luna" }
const terra: ModelRef = { providerID: "openai", id: "gpt-terra" }

function memoryStorage(): HostStorage {
  const store = new Map<string, unknown>()
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.has(key) ? (store.get(key) as T) : undefined
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value)
    },
  }
}

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    id: `d-${Math.random().toString(36).slice(2, 8)}`,
    sessionID: "ses-1",
    at: 1_000,
    promptPreview: "test",
    classification: {
      taskClass: "chat",
      complexity: 0.1,
      band: "trivial",
      confidence: 0.5,
      signals: [],
      estOutputTokens: 100,
    },
    tier: "cheap",
    selected: luna,
    selectedName: "GPT Luna",
    switched: true,
    reason: "band=trivial",
    mode: "auto",
    verification: "pending",
    ...overrides,
  }
}

function makeTelemetry(storage?: HostStorage) {
  let clock = 10_000
  const telemetry = new Telemetry(storage ?? memoryStorage(), DEFAULT_CONFIG, () => clock)
  return {
    telemetry,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

describe("decision lifecycle", () => {
  test("records and exposes the active decision per session", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision())
    expect(telemetry.pendingFor("ses-1")?.selected).toEqual(luna)
    expect(telemetry.decisionCount).toBe(1)
  })

  test("a new decision for the same session supersedes the old one", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision({ id: "d-1" }))
    telemetry.recordDecision(decision({ id: "d-2" }))
    expect(telemetry.pendingFor("ses-1")?.id).toBe("d-2")
    const superseded = telemetry.recentDecisions(10).find((d) => d.id === "d-1")
    expect(superseded?.verification).toBe("superseded")
  })

  test("finalizeSession clears the active slot", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision())
    telemetry.finalizeSession("ses-1")
    expect(telemetry.pendingFor("ses-1")).toBeUndefined()
  })
})

describe("verification loop", () => {
  test("matching model marks the decision verified", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision())
    const d = telemetry.applyMessageCompleted({
      sessionID: "ses-1",
      messageID: "m1",
      model: luna,
      tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.01,
      startedAt: 1_000,
      completedAt: 2_000,
      finish: "stop",
    })
    expect(d?.verification).toBe("verified")
    expect(d?.actualModel).toEqual(luna)
    expect(telemetry.statsFor(luna).verified).toBe(1)
    expect(telemetry.verificationSummary().rate).toBe(1)
  })

  test("different model marks a mismatch and counts it", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision())
    const d = telemetry.applyMessageCompleted({
      sessionID: "ses-1",
      messageID: "m1",
      model: terra,
      tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.02,
      finish: "stop",
    })
    expect(d?.verification).toBe("mismatch")
    expect(d?.actualModel).toEqual(terra)
    expect(telemetry.verificationSummary()).toMatchObject({ verified: 0, mismatch: 1 })
  })

  test("tool-call continuations accumulate into the same outcome", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision())
    telemetry.applyMessageCompleted({
      sessionID: "ses-1",
      messageID: "m1",
      model: luna,
      tokens: { input: 1000, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.01,
      finish: "tool-calls",
    })
    telemetry.applyMessageCompleted({
      sessionID: "ses-1",
      messageID: "m2",
      model: luna,
      tokens: { input: 2000, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.02,
      finish: "stop",
    })
    const d = telemetry.pendingFor("ses-1")
    expect(d?.outcome?.inputTokens).toBe(3000)
    expect(d?.outcome?.outputTokens).toBe(400)
    expect(d?.outcome?.costUsd).toBeCloseTo(0.03)
    expect(d?.outcome?.success).toBe(true)
  })

  test("error finishes mark failure", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision())
    const d = telemetry.applyMessageCompleted({
      sessionID: "ses-1",
      messageID: "m1",
      model: luna,
      tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      finish: "error",
      error: "500",
    })
    expect(d?.outcome?.success).toBe(false)
    expect(telemetry.statsFor(luna).failures).toBe(1)
  })

  test("idle without completion marks unobserved", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision())
    const unobserved = telemetry.finalizeSession("ses-1")
    expect(unobserved?.verification).toBe("unobserved")
  })
})

describe("spend tracking", () => {
  test("accumulates per session and per day", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision({ sessionID: "ses-a" }))
    telemetry.applyMessageCompleted({
      sessionID: "ses-a",
      model: luna,
      costUsd: 0.5,
      finish: "stop",
    })
    telemetry.recordDecision(decision({ sessionID: "ses-b" }))
    telemetry.applyMessageCompleted({
      sessionID: "ses-b",
      model: luna,
      costUsd: 1.5,
      finish: "stop",
    })
    expect(telemetry.sessionSpendUsd("ses-a")).toBeCloseTo(0.5)
    expect(telemetry.sessionSpendUsd("ses-b")).toBeCloseTo(1.5)
    expect(telemetry.dailySpendUsd(10_000)).toBeCloseTo(2)
  })
})

describe("persistence", () => {
  test("round-trips records, stats, and verification state", async () => {
    const storage = memoryStorage()
    const a = makeTelemetry(storage)
    a.telemetry.recordDecision(decision())
    a.telemetry.applyMessageCompleted({
      sessionID: "ses-1",
      model: luna,
      costUsd: 0.25,
      finish: "stop",
      tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    await a.telemetry.persist()

    const b = makeTelemetry(storage)
    await b.telemetry.load()
    const loaded = b.telemetry.recentDecisions(10)[0]
    expect(loaded?.verification).toBe("verified")
    expect(loaded?.outcome?.costUsd).toBeCloseTo(0.25)
    expect(b.telemetry.statsFor(luna).uses).toBe(1)
    expect(b.telemetry.dailySpendUsd(10_000)).toBeCloseTo(0.25)
  })

  test("hydration survives garbage", async () => {
    const storage = memoryStorage()
    await storage.set("router/records", [{ nonsense: true }, null, "junk"])
    const { telemetry } = makeTelemetry(storage)
    await telemetry.load()
    expect(telemetry.decisionCount).toBe(0)
  })
})

describe("reports", () => {
  test("report and stats lines include decisions and models", () => {
    const { telemetry } = makeTelemetry()
    telemetry.recordDecision(decision())
    telemetry.applyMessageCompleted({
      sessionID: "ses-1",
      model: luna,
      costUsd: 0.25,
      finish: "stop",
      tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const report = telemetry.reportLines().join("\n")
    expect(report).toContain("openai/gpt-luna")
    expect(report).toContain("verified")
    const stats = telemetry.statsLines().join("\n")
    expect(stats).toContain("openai/gpt-luna")
  })
})
