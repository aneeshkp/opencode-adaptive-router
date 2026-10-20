/**
 * WireEventNormalizer tests.
 *
 * Payloads are copied from the live V2 event stream (OpenCode 2.0.x),
 * captured while verifying the routing seam end to end. They are the
 * regression contract for wire-format drift: if OpenCode renames or
 * reshapes these events, these tests fail before the verification loop
 * silently degrades to "pending" in production.
 */

import { describe, expect, it } from "vitest"
import { WireEventNormalizer } from "../src/adapters/opencode"

const SES = "ses_ea64669e4ffeN59dy2BQZCNVFS"

/** Build a wire envelope the way the stream sends it: payload in `data`. */
function wire(type: string, data: Record<string, unknown>, created = 1792506701918) {
  return { id: "evt_test", created, type, durable: { aggregateID: SES, seq: 1, version: 1 }, data }
}

function completed(events: ReturnType<WireEventNormalizer["normalize"]>, index = 0) {
  const event = events[index]
  if (!event || event.type !== "message.completed") {
    throw new Error(`expected message.completed at ${index}, got ${JSON.stringify(event)}`)
  }
  return event
}

describe("WireEventNormalizer (V2 wire format)", () => {
  it("correlates step.started + step.ended into one message.completed", () => {
    const n = new WireEventNormalizer()
    expect(
      n.normalize(
        wire(
          "session.step.started",
          {
            sessionID: SES,
            assistantMessageID: "msg_159b996640018PTBsQAxdy1Jn6",
            agent: "terra",
            model: { id: "gpt-6-luna", providerID: "openai", variant: "default" },
            started: 1792506697330,
          },
          1792506701147,
        ),
      ),
    ).toHaveLength(0)

    const events = n.normalize(
      wire(
        "session.step.ended",
        {
          sessionID: SES,
          assistantMessageID: "msg_159b996640018PTBsQAxdy1Jn6",
          finish: "stop",
          native: { responseId: "resp_02e1514a", serviceTier: "default" },
          cost: 0.0029563,
          tokens: { input: 4300, output: 5000, reasoning: 0, cache: { read: 2800, write: 900 } },
        },
        1792506701918,
      ),
    )
    expect(events).toHaveLength(1)
    const ev = completed(events)
    expect(ev.sessionID).toBe(SES)
    expect(ev.messageID).toBe("msg_159b996640018PTBsQAxdy1Jn6")
    expect(ev.model).toEqual({ providerID: "openai", id: "gpt-6-luna" }) // variant ignored
    expect(ev.tokens).toEqual({
      input: 4300,
      output: 5000,
      reasoning: 0,
      cacheRead: 2800,
      cacheWrite: 900,
    })
    expect(ev.costUsd).toBeCloseTo(0.0029563, 8)
    expect(ev.startedAt).toBe(1792506697330)
    expect(ev.completedAt).toBe(1792506701918)
    expect(ev.finish).toBe("stop")
    expect(ev.error).toBeUndefined()
  })

  it("keeps multiple in-flight steps separate by message id", () => {
    const n = new WireEventNormalizer()
    n.normalize(
      wire("session.step.started", {
        sessionID: SES,
        assistantMessageID: "msg_a",
        model: { id: "gpt-6-luna", providerID: "openai" },
        started: 1000,
      }),
    )
    n.normalize(
      wire("session.step.started", {
        sessionID: SES,
        assistantMessageID: "msg_b",
        model: { id: "gpt-6.1-sol", providerID: "openai" },
        started: 2000,
      }),
    )
    // Tool-call continuations interleave: b can end before a.
    const evB = completed(
      n.normalize(
        wire("session.step.ended", { sessionID: SES, assistantMessageID: "msg_b", finish: "tool-calls", cost: 0.01 }, 3000),
      ),
    )
    const evA = completed(
      n.normalize(
        wire("session.step.ended", { sessionID: SES, assistantMessageID: "msg_a", finish: "stop", cost: 0.02 }, 4000),
      ),
    )
    expect(evB.model?.id).toBe("gpt-6.1-sol")
    expect(evB.startedAt).toBe(2000)
    expect(evA.model?.id).toBe("gpt-6-luna")
    expect(evA.startedAt).toBe(1000)
  })

  it("emits message.completed with no model when step.ended arrives without step.started", () => {
    const n = new WireEventNormalizer()
    const ev = completed(
      n.normalize(
        wire("session.step.ended", { sessionID: SES, assistantMessageID: "msg_x", finish: "stop", cost: 0.001 }, 5000),
      ),
    )
    expect(ev.model).toBeUndefined()
    expect(ev.finish).toBe("stop")
  })

  it("maps execution.succeeded to session.idle", () => {
    const n = new WireEventNormalizer()
    const events = n.normalize(wire("session.execution.succeeded", { sessionID: SES }))
    expect(events).toEqual([{ type: "session.idle", sessionID: SES }])
  })

  it("maps execution.failed to message.error followed by session.idle", () => {
    const n = new WireEventNormalizer()
    const events = n.normalize(
      wire("session.execution.failed", { sessionID: SES, error: { message: "provider unavailable" } }),
    )
    expect(events).toHaveLength(2)
    const [err, idle] = events
    if (err?.type !== "message.error" || idle?.type !== "session.idle") {
      throw new Error(`unexpected events ${JSON.stringify(events)}`)
    }
    expect(err.sessionID).toBe(SES)
    expect(err.error).toBe("provider unavailable")
    expect(idle.sessionID).toBe(SES)
  })

  it("maps model.selected to session.updated with the model ref", () => {
    const n = new WireEventNormalizer()
    const events = n.normalize(
      wire("session.model.selected", { sessionID: SES, model: { id: "gpt-6-luna", providerID: "openai" } }),
    )
    expect(events).toEqual([
      { type: "session.updated", sessionID: SES, model: { providerID: "openai", id: "gpt-6-luna" } },
    ])
  })

  it("maps session.removed through", () => {
    const n = new WireEventNormalizer()
    expect(n.normalize(wire("session.removed", { sessionID: SES }))).toEqual([
      { type: "session.removed", sessionID: SES },
    ])
  })

  it("accepts payloads nested in properties (older builds) or the raw envelope", () => {
    const n = new WireEventNormalizer()
    expect(
      n.normalize({ type: "session.execution.succeeded", properties: { sessionID: SES } }),
    ).toEqual([{ type: "session.idle", sessionID: SES }])
    expect(n.normalize({ type: "session.execution.succeeded", sessionID: SES })).toEqual([
      { type: "session.idle", sessionID: SES },
    ])
  })

  it("extracts flat cache fields when cache is not nested", () => {
    const n = new WireEventNormalizer()
    n.normalize(
      wire("session.step.started", {
        sessionID: SES,
        assistantMessageID: "msg_flat",
        model: { id: "m", providerID: "p" },
      }),
    )
    const ev = completed(
      n.normalize(
        wire("session.step.ended", {
          sessionID: SES,
          assistantMessageID: "msg_flat",
          tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
        }),
      ),
    )
    expect(ev.tokens).toEqual({ input: 10, output: 20, reasoning: 0, cacheRead: 30, cacheWrite: 40 })
  })

  it("ignores known-but-unused stream events and unknown types without throwing", () => {
    const n = new WireEventNormalizer()
    for (const type of [
      "session.created",
      "session.inbox.enqueued",
      "session.text.delta",
      "session.usage.updated",
      "session.step.streamed",
      "totally.new.event",
    ]) {
      expect(n.normalize(wire(type, { sessionID: SES }))).toEqual([])
    }
  })

  it("returns nothing for malformed envelopes", () => {
    const n = new WireEventNormalizer()
    expect(n.normalize("message.completed")).toEqual([])
    expect(n.normalize(null)).toEqual([])
    expect(n.normalize({})).toEqual([])
    expect(n.normalize({ type: 42 })).toEqual([])
    expect(n.normalize({ type: "session.step.ended" })).toEqual([]) // no sessionID
  })
})
