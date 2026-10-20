import { describe, expect, test } from "vitest"
import { classify, extractFeatures, emptySession } from "../src/core/analyzer"

function analyze(text: string, session = emptySession(), attachments = 0) {
  return {
    text,
    features: extractFeatures(text, attachments),
    session,
    repo: undefined,
  }
}

describe("extractFeatures", () => {
  test("counts code fences as pairs", () => {
    const f = extractFeatures("Look:\n```go\nfmt.Println(1)\n```\nand ```ts\nx\n```")
    expect(f.codeFenceCount).toBe(2)
  })

  test("counts file paths but not bare words", () => {
    const f = extractFeatures("fix src/core/router.ts and test/policy.test.ts please")
    expect(f.filePathRefCount).toBe(2)
  })

  test("detects stacktraces", () => {
    expect(
      extractFeatures("panic: runtime error: index out of range").hasStacktrace,
    ).toBe(true)
    expect(
      extractFeatures("Traceback (most recent call last): boom").hasStacktrace,
    ).toBe(true)
    expect(extractFeatures("hello world").hasStacktrace).toBe(false)
  })

  test("counts questions and bullets", () => {
    const f = extractFeatures("What is this?\nWhy?\n- a\n- b\n1. c")
    expect(f.questionCount).toBe(2)
    expect(f.bulletLineCount).toBe(3)
  })

  test("estimates tokens from length", () => {
    expect(extractFeatures("abcd".repeat(10)).estTokens).toBe(10)
  })
})

describe("classify", () => {
  test("greetings route to chat/trivial", () => {
    const c = classify(analyze("Say OK"))
    expect(c.taskClass).toBe("chat")
    expect(c.band).toBe("trivial")
    expect(c.estOutputTokens).toBeLessThan(200)
  })

  test("failure language routes to debug", () => {
    const c = classify(analyze("This test fails with exit code 1, the build is broken"))
    expect(c.taskClass).toBe("debug")
    expect(c.band).not.toBe("very_complex")
  })

  test("stack traces raise complexity", () => {
    const c = classify(
      analyze(
        "Diagnose this:\n```\nTraceback (most recent call last):\n  File \"x.py\", line 1\nValueError\n```",
      ),
    )
    expect(c.taskClass).toBe("debug")
    expect(c.complexity).toBeGreaterThan(0.3)
  })

  test("architecture language routes to architecture and stays non-trivial", () => {
    const c = classify(
      analyze(
        "Should we adopt event sourcing for the billing service? Compare the tradeoffs with our current CRUD design and propose a migration plan.",
      ),
    )
    expect(c.taskClass).toBe("architecture")
  })

  test("implementation request with file paths routes to code_write", () => {
    const c = classify(analyze("Implement rate limiting in src/server/middleware.go and add tests"))
    expect(c.taskClass).toBe("code_write")
    expect(c.band === "simple" || c.band === "moderate" || c.band === "complex").toBe(true)
  })

  test("question-only prompts route to explain", () => {
    const c = classify(analyze("What is a Worktree in OpenCode?"))
    expect(c.taskClass).toBe("explain")
  })

  test("long multi-part prompts score higher complexity", () => {
    const short = classify(analyze("Say OK"))
    const long = classify(
      analyze(
        "Refactor the routing engine. First extract the policy module, then update all callers in src/core/router.ts, " +
          "test/policy.test.ts and test/router.test.ts. After that, update the docs. Also add benchmarks, " +
          "then clean up the deprecated helpers. Finally explain what changed.\n\n" +
          "```ts\nconst x: number = 1\nconst y = compute(x)\n```\n" +
          "Consider src/a.ts, src/b.ts, src/c.ts, src/d.ts.",
      ),
    )
    expect(long.complexity).toBeGreaterThan(short.complexity + 0.3)
    expect(["complex", "very_complex"]).toContain(long.band)
  })

  test("session context pressure raises complexity", () => {
    const small = classify(analyze("Explain this function"))
    const large = classify(
      analyze("Explain this function", {
        messageCount: 80,
        estTokens: 80_000,
        hasRecentError: false,
        recentUserTexts: [],
      }),
    )
    expect(large.complexity).toBeGreaterThan(small.complexity)
  })

  test("short pronoun follow-up continues the previous class", () => {
    const c = classify(analyze("yes, do that now", {
      messageCount: 10,
      estTokens: 4000,
      hasRecentError: false,
      recentUserTexts: ["now implement the parser"],
    }), { lastClass: "code_write" })
    expect(c.taskClass).toBe("code_write")
  })

  test("signals list is populated for evidence", () => {
    const c = classify(analyze("Review my pull request for the auth refactor"))
    expect(c.signals.length).toBeGreaterThan(0)
    expect(c.confidence).toBeGreaterThan(0.3)
  })
})

describe("calibration regressions (golden-set fixes)", () => {
  test("plural failure nouns classify as debug", () => {
    // "errors"/"failures" are how users actually report problems.
    expect(classify(analyze("Users report 500 errors on login after the deploy")).taskClass).toBe("debug")
    expect(classify(analyze("The dashboards show intermittent failures since Monday")).taskClass).toBe("debug")
  })

  test("guide and runbook requests classify as docs", () => {
    expect(classify(analyze("Add the onboarding runbook for new contributors")).taskClass).toBe("docs")
    expect(classify(analyze("Write the v3 migration guide, it must cover every breaking change")).taskClass).toBe("docs")
  })

  test("review intent beats failure vocabulary on ties", () => {
    // "Critique the exception handling" is a review, not a debug report.
    expect(classify(analyze("Critique the exception handling across the service layer")).taskClass).toBe("review")
  })

  test("documentation intent beats construction verbs on ties", () => {
    expect(
      classify(analyze("Document the full configuration schema in docs/configuration.md")).taskClass,
    ).toBe("docs")
  })

  test("short imperative ops commands classify as ops, not chat", () => {
    expect(classify(analyze("Deploy the canary to staging")).taskClass).toBe("ops")
    expect(classify(analyze("Scale the deployment to 5 replicas with kubectl")).taskClass).toBe("ops")
    // "plan" is architecture vocabulary, but a terraform run is ops.
    expect(classify(analyze("Run the terraform plan for staging")).taskClass).toBe("ops")
  })

  test("ops command form requires an ops keyword elsewhere", () => {
    // "run" alone must not make a test-suite request ops.
    expect(classify(analyze("Run the test suite for the analyzer")).taskClass).toBe("test")
  })

  test("single-verb build requests classify as code_write, not chat", () => {
    expect(classify(analyze("Add a /healthz endpoint to the server")).taskClass).toBe("code_write")
    expect(classify(analyze("Create a CLI subcommand for exporting metrics")).taskClass).toBe("code_write")
  })
})
