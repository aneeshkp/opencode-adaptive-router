import { describe, expect, test } from "vitest"
import { RouterEngine } from "../src/router"
import { card, FakeHost } from "./fake-host"
import type { ModelRef } from "../src/core/types"

const luna: ModelRef = { providerID: "openai", id: "gpt-luna" }
const terra: ModelRef = { providerID: "openai", id: "gpt-terra" }
const sol: ModelRef = { providerID: "openai", id: "gpt-sol" }

async function makeEngine(options?: Record<string, unknown>) {
  const host = new FakeHost()
  host.addSession("ses-1", { model: terra })
  const engine = new RouterEngine(host, options)
  await engine.init()
  return { host, engine }
}

function admit(engine: RouterEngine, host: FakeHost, text: string, sessionID = "ses-1") {
  return engine.handlePromptAdmission({
    sessionID,
    text,
    attachmentCount: 0,
    setText: () => {},
  })
}

describe("routing seam", () => {
  test("trivial prompts switch to the cheap tier", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    expect(host.switchCalls.length).toBe(1)
    expect(host.switchCalls[0]!.model).toEqual(luna)
    const logs = host.logs.map((l) => l.message).join("\n")
    expect(logs).toContain("tier=cheap")
    expect(logs).toContain("openai/gpt-luna")
  })

  test("complex prompts switch to the powerful tier", async () => {
    const { host, engine } = await makeEngine()
    await admit(
      engine,
      host,
      "Redesign the routing engine's architecture for our platform. Compare the tradeoffs of " +
        "policy-per-turn selection versus session-level routing plans, evaluate three candidate " +
        "designs including a learned-router approach, and propose a migration strategy. Then " +
        "implement the migration across src/core/router.ts, src/core/policy.ts, src/core/registry.ts, " +
        "src/adapters/opencode.ts and all of their tests. First extract the shared types into a " +
        "dedicated module, then update every caller, then add benchmarks. Also document the new " +
        "design in README.md, handle backward compatibility for existing configs, and explain " +
        "how the escalation path changes. Here is the current policy shape:\n\n" +
        "```ts\ninterface PolicyDecision { tier: Tier; reason: string }\n```\n\n" +
        "Make sure the verification loop still catches seam mismatches after the refactor.",
    )
    expect(host.switchCalls.length).toBe(1)
    expect(host.switchCalls[0]!.model).toEqual(sol)
  })

  test("moderate prompts land on balanced", async () => {
    const host = new FakeHost()
    host.addSession("ses-1", { model: luna })
    const engine = new RouterEngine(host)
    await engine.init()
    await admit(engine, host, "Implement input validation for the config parser in src/config.ts and add unit tests for the edge cases")
    expect(host.switchCalls[0]!.model).toEqual(terra)
  })

  test("already-on-model decisions do not switch", async () => {
    const host = new FakeHost()
    host.addSession("ses-1", { model: luna })
    const engine = new RouterEngine(host)
    await engine.init()
    await admit(engine, host, "Say OK")
    expect(host.switchCalls).toHaveLength(0)
  })

  test("advisory mode records but never switches", async () => {
    const { host, engine } = await makeEngine({ mode: "advisory" })
    await admit(engine, host, "Say OK")
    expect(host.switchCalls).toHaveLength(0)
    expect(host.logs.map((l) => l.message).join("\n")).toContain("advisory")
  })

  test("subagent sessions are skipped", async () => {
    const { host, engine } = await makeEngine()
    host.addSession("ses-child", { parentID: "ses-1", model: terra })
    await admit(engine, host, "Implement something complex and hard", "ses-child")
    expect(host.switchCalls).toHaveLength(0)
  })

  test("slash-command prompts are not routed and do not disturb the active decision", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "/router report")
    expect(host.switchCalls).toHaveLength(0)
    // `opencode run` submits prompts wrapped in literal quotes; the skip
    // must still recognize the command inside the quotes.
    await admit(engine, host, '"/router report"')
    expect(host.switchCalls).toHaveLength(0)
    await admit(engine, host, "Say OK")
    expect(host.switchCalls.length).toBe(1)
    const pending = engine.pendingDecisionFor("ses-1")
    expect(pending).toBeDefined()
    await admit(engine, host, "/router stats")
    expect(engine.pendingDecisionFor("ses-1")?.id).toBe(pending!.id)
    expect(host.switchCalls.length).toBe(1)
  })

  test("stickiness keeps the same model within a tier across turns", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    expect(host.switchCalls[0]!.model).toEqual(luna)
    await admit(engine, host, "Thanks, say OK again")
    const last = host.switchCalls[host.switchCalls.length - 1]!.model
    expect(last).toEqual(luna)
    // But a complex prompt in the same session moves up.
    await admit(
      engine,
      host,
      "Now redesign the whole system architecture: compare the tradeoffs of several approaches, " +
        "evaluate a learned router against the rule-based one, plan the migration across every " +
        "module including src/core/router.ts, src/core/policy.ts, src/core/registry.ts and " +
        "src/core/telemetry.ts, then implement it end to end with tests, benchmarks and docs. " +
        "First extract the shared types, then update all callers, then handle config migration.",
    )
    expect(host.switchCalls[host.switchCalls.length - 1]!.model).toEqual(sol)
  })
})

describe("manual override", () => {
  test("external model change disables routing for the session", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    expect(host.switchCalls.length).toBe(1)

    // User picks a model manually between prompts.
    const session = host.sessions.get("ses-1")!
    session.model = sol

    await admit(engine, host, "Say OK again")
    expect(host.switchCalls.length).toBe(1) // no new switch
    expect(host.logs.map((l) => l.message).join("\n")).toContain("routing disabled")
  })

  test("session.updated with a foreign model also disables routing", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    host.emit({ type: "session.updated", sessionID: "ses-1", model: sol })
    await admit(engine, host, "Say OK again")
    expect(host.switchCalls.length).toBe(1)
  })
})

describe("verification loop", () => {
  test("completed turn on the selected model is verified", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    host.emitCompleted("ses-1", luna, { costUsd: 0.001 })
    const report = engine.runCommand("report")
    expect(report).toContain("verified")
    expect(host.warnings()).toHaveLength(0)
  })

  test("completed turn on a different model is flagged as a seam mismatch", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    host.emitCompleted("ses-1", terra)
    const mismatchLogs = host.logs.filter((l) => l.message.includes("SEAM MISMATCH"))
    expect(mismatchLogs.length).toBe(1)
    expect(engine.runCommand("report")).toContain("mismatch")
  })

  test("idle without completion is flagged unobserved", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    host.emit({ type: "session.idle", sessionID: "ses-1" })
    expect(host.logs.map((l) => l.message).join("\n")).toContain("without an observed completion")
  })
})

describe("failure escalation", () => {
  function retryInput(host: FakeHost, error: { type: string; message: string; status?: number }, model?: ModelRef) {
    let accepted: number | undefined
    let vetoed = false
    const input = {
      sessionID: "ses-1",
      model: model ?? host.switchCalls[0]!.model,
      attempt: 1,
      error,
      acceptRetry: (delay: number) => {
        accepted = delay
      },
      vetoRetry: () => {
        vetoed = true
      },
    }
    return { input, accepted: () => accepted, vetoed: () => vetoed }
  }

  test("transient failure escalates one tier and accepts the retry", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK") // -> luna (cheap)
    const { input, accepted } = retryInput(host, { type: "provider.error", message: "overloaded", status: 503 })
    await engine.handleRetry(input)
    expect(accepted()).toBe(500)
    expect(host.switchCalls[1]!.model).toEqual(terra) // cheap -> balanced
    expect(host.logs.map((l) => l.message).join("\n")).toContain("escalating")
  })

  test("auth failures do not escalate", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    const { input, accepted, vetoed } = retryInput(host, { type: "provider.error", message: "bad key", status: 401 })
    await engine.handleRetry(input)
    expect(accepted()).toBeUndefined()
    expect(vetoed()).toBe(false)
    expect(host.switchCalls.length).toBe(1)
  })

  test("escalation respects maxHops and resets on idle", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    const first = retryInput(host, { type: "provider.error", message: "overloaded", status: 503 })
    await engine.handleRetry(first.input)
    const second = retryInput(host, { type: "provider.error", message: "overloaded", status: 503 }, terra)
    // Second failure would escalate again, but maxHops=1 blocks it.
    await engine.handleRetry(second.input)
    expect(host.switchCalls.length).toBe(2)
    // Idle resets the hop counter for the next turn.
    host.emit({ type: "session.idle", sessionID: "ses-1" })
    await admit(engine, host, "Say OK")
    const third = retryInput(host, { type: "provider.error", message: "overloaded", status: 503 })
    await engine.handleRetry(third.input)
    expect(host.switchCalls.length).toBe(4)
  })
})

describe("budget guard", () => {
  test("overspent sessions are forced to the cheapest tier", async () => {
    const host = new FakeHost()
    host.addSession("ses-1", { model: terra })
    const engine = new RouterEngine(host, { budget: { sessionMaxUsd: 0.01 } })
    await engine.init()

    // Seed spend by completing an expensive turn.
    await admit(engine, host, "Say OK")
    host.emitCompleted("ses-1", host.switchCalls[0]!.model, { costUsd: 5 })
    host.emit({ type: "session.idle", sessionID: "ses-1" })

    await admit(
      engine,
      host,
      "Redesign the entire platform architecture and implement everything with full migration plans",
    )
    expect(host.switchCalls[host.switchCalls.length - 1]!.model).toEqual(luna)
    expect(host.logs.map((l) => l.message).join("\n")).toContain("over budget")
  })
})

describe("commands", () => {
  test("report, stats, and status render", async () => {
    const { host, engine } = await makeEngine()
    await admit(engine, host, "Say OK")
    host.emitCompleted("ses-1", luna, { costUsd: 0.001 })
    expect(engine.runCommand("report")).toContain("Router report")
    expect(engine.runCommand("stats")).toContain("gpt-luna")
    expect(engine.runCommand("status")).toContain("mode=auto")
  })
})

describe("fault tolerance", () => {
  test("host failures during routing never break the prompt", async () => {
    const host = new FakeHost()
    host.addSession("ses-1", { model: terra })
    const engine = new RouterEngine(host)
    await engine.init()
    host.getSession = async () => {
      throw new Error("boom")
    }
    await admit(engine, host, "Say OK")
    expect(host.logs.some((l) => l.level === "error")).toBe(true)
  })

  test("empty registry skips routing with a warning", async () => {
    const host = new FakeHost([card("x", "only", { tools: false })])
    host.addSession("ses-1", { model: terra })
    const engine = new RouterEngine(host)
    await engine.init()
    await admit(engine, host, "Say OK")
    expect(host.switchCalls).toHaveLength(0)
  })
})
