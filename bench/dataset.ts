/**
 * Golden-set benchmark dataset.
 *
 * 80 hand-labeled prompts, 8 per task class. Labels record the tier that
 * *should* serve each prompt under the router's design intent:
 *
 *   - pure acknowledgments and quick lookups       -> cheap
 *   - real code work on a single concern           -> balanced
 *     (code classes are floored at balanced)
 *   - multi-file, multi-step, or deeply analytical -> powerful
 *
 * Prompts are written the way people actually prompt agents. Labels were
 * assigned by hand from intent (not by running the classifier); where the
 * benchmark disagrees, either the classifier has a real gap or the prompt
 * is genuinely ambiguous — both are findings, tracked in the README's
 * benchmark section. Every prompt is classified against an empty session,
 * so session-continuation signals are intentionally not exercised here.
 */

import type { TaskClass, Tier } from "../src/core/types"

export interface LabeledPrompt {
  text: string
  expectedClass: TaskClass
  expectedTier: Tier
  /** Calibration note: why this label. */
  note: string
}

export const DATASET: readonly LabeledPrompt[] = [
  /* ------------------------------ chat ------------------------------ */
  // Pure acknowledgments: no class signal, trivial band -> cheap.
  { text: "Say OK", expectedClass: "chat", expectedTier: "cheap", note: "pure acknowledgment" },
  { text: "thanks!", expectedClass: "chat", expectedTier: "cheap", note: "pure acknowledgment" },
  { text: "hi", expectedClass: "chat", expectedTier: "cheap", note: "greeting" },
  { text: "ok got it, continue", expectedClass: "chat", expectedTier: "cheap", note: "ack + continue" },
  { text: "sounds good, proceed", expectedClass: "chat", expectedTier: "cheap", note: "approval" },
  { text: "nice", expectedClass: "chat", expectedTier: "cheap", note: "pure acknowledgment" },
  { text: "got it, thanks", expectedClass: "chat", expectedTier: "cheap", note: "acknowledgment" },
  { text: "sure, go ahead", expectedClass: "chat", expectedTier: "cheap", note: "approval" },

  /* ----------------------------- explain ---------------------------- */
  // Quick conceptual questions: short, question-shaped -> cheap.
  {
    text: "What is a closure in JavaScript?",
    expectedClass: "explain",
    expectedTier: "cheap",
    note: "single conceptual question",
  },
  {
    text: "How does the retry hook decide delays?",
    expectedClass: "explain",
    expectedTier: "cheap",
    note: "single mechanism question",
  },
  {
    text: "What does this regex do: `(?<=\\d)\\.(?=\\d)`",
    expectedClass: "explain",
    expectedTier: "cheap",
    note: "decode one expression",
  },
  {
    text: "Why does Go require goroutine leak checks?",
    expectedClass: "explain",
    expectedTier: "cheap",
    note: "single why question",
  },
  {
    text: "What is the difference between PUT and PATCH?",
    expectedClass: "explain",
    expectedTier: "cheap",
    note: "comparison lookup",
  },
  {
    text: "Walk me through the OAuth authorization code flow",
    expectedClass: "explain",
    expectedTier: "cheap",
    note: "narrative explanation of one flow",
  },
  {
    text: "Explain how TCP congestion control works. Cover slow start, congestion avoidance, and fast recovery; then explain how the CUBIC algorithm differs from Reno in its window growth function; and finally describe what happens to the congestion window when a packet is lost versus when the round-trip time suddenly doubles. Also explain why aggressive window growth can starve competing flows that share the same bottleneck link.",
    expectedClass: "explain",
    expectedTier: "balanced",
    note: "multi-part technical explanation",
  },
  {
    text: "Explain how this project's routing engine verifies that the model it picked actually served the turn. Walk through what happens when a prompt is admitted and classified, then how the event stream reports each model call that belongs to the turn, and finally how a decision settles as verified, mismatched, or unobserved in telemetry; also explain where the persisted records live and how the report command summarizes them for a human.",
    expectedClass: "explain",
    expectedTier: "balanced",
    note: "multi-part system explanation",
  },

  /* ------------------------------ docs ------------------------------ */
  // Small writing tasks -> cheap; guides covering many concerns -> balanced.
  {
    text: "Add a changelog entry for v2.3.0",
    expectedClass: "docs",
    expectedTier: "cheap",
    note: "one-line changelog entry",
  },
  {
    text: "Update the README getting started section to mention the new config file",
    expectedClass: "docs",
    expectedTier: "cheap",
    note: "small README edit",
  },
  {
    text: "Document the new CLI flags in README.md",
    expectedClass: "docs",
    expectedTier: "cheap",
    note: "document a few flags",
  },
  {
    text: "Write a docstring for the parseConfig function",
    expectedClass: "docs",
    expectedTier: "cheap",
    note: "single docstring",
  },
  {
    text: "Document the deprecated endpoints in docs/api.md",
    expectedClass: "docs",
    expectedTier: "cheap",
    note: "list deprecations",
  },
  {
    text: "Document the full configuration schema in docs/configuration.md. For every option cover its type, its default value, and a short usage example; then add a troubleshooting section for the most common misconfigurations we see in bug reports, and finally cross-link each option from the quickstart table in README.md so new readers can jump straight from setup to the details without hunting through pages of prose.",
    expectedClass: "docs",
    expectedTier: "balanced",
    note: "schema guide with multiple sections",
  },
  {
    text: "Write the v3 migration guide. It must cover every breaking change: the config format switch from JSON to TOML, the renamed plugin options, the new permission model for hooks, and the removed legacy APIs; for each change include a before and after snippet in the guide, then add a step-by-step upgrade path ordered by risk, and finally include a rollback section explaining how to keep both versions running side by side during a long transition window.",
    expectedClass: "docs",
    expectedTier: "balanced",
    note: "multi-section migration guide",
  },
  {
    text: "Document the troubleshooting runbook for the release process. Cover the ways releases break: artifact builds that time out in the pipeline, flaky package upgrades that leave releases half-installed, and nodes that join the fleet without the labels the deploy scripts expect; then write down the diagnostic commands for each, and finally add an escalation section describing when to page the on-call engineer and what context to include in the page.",
    expectedClass: "docs",
    expectedTier: "balanced",
    note: "playbook with diagnosis + escalation",
  },

  /* ----------------------------- review ----------------------------- */
  // Quick once-overs -> cheap; risk/security/perf reviews -> balanced.
  {
    text: "Review my pull request",
    expectedClass: "review",
    expectedTier: "cheap",
    note: "generic review ask",
  },
  {
    text: "Look over my diff before I merge",
    expectedClass: "review",
    expectedTier: "cheap",
    note: "sanity check",
  },
  {
    text: "Check my changes for typos and obvious mistakes",
    expectedClass: "review",
    expectedTier: "cheap",
    note: "surface-level check",
  },
  {
    text: "Give me feedback on this code",
    expectedClass: "review",
    expectedTier: "cheap",
    note: "generic feedback ask",
  },
  {
    text: "Review the authentication changes in this PR. Check the token refresh logic in src/auth/tokens.ts for race conditions between the refresh path and the request path, verify the new rate limiter in src/middleware/ratelimit.ts actually drops excess traffic instead of queueing it, and confirm the session migration preserves existing users; then summarize the risks you find ranked by severity before I merge any of it.",
    expectedClass: "review",
    expectedTier: "balanced",
    note: "targeted concurrency + migration review",
  },
  {
    text: "Review this pull request for security issues. Look at how user input flows from the controllers into the query builder, check the new file upload path for unrestricted size and content type, audit the session cookie flags, and scan for any place secrets could leak into logs; then write up your findings with severity ratings, and finally rank what should block the release versus what can be a fast follow.",
    expectedClass: "review",
    expectedTier: "balanced",
    note: "security review with write-up",
  },
  {
    text: "Critique the exception handling across the service layer. Map out which modules swallow problems silently, which ones wrap them with context, and which ones let raw driver faults escape to callers; then propose a consistent taxonomy with typed classes, and finally show how the HTTP handlers should translate each type to status codes without leaking internals to clients. Also flag any module where the current behavior would make an outage harder to diagnose, and note which callers depend on the raw shapes today.",
    expectedClass: "review",
    expectedTier: "balanced",
    note: "cross-cutting critique + proposal",
  },
  {
    text: "Do a performance review of the request path. Read the handler code in src/api/handlers.ts and the middleware chain in src/api/middleware.ts, look for N+1 query patterns, unnecessary allocations in the hot loop, and blocking calls inside async handlers; then estimate which changes give the biggest win, and finally list the follow-up benchmarks we should run before and after each change so we can prove the improvement.",
    expectedClass: "review",
    expectedTier: "balanced",
    note: "perf review with measurements plan",
  },

  /* ------------------------------ ops ------------------------------- */
  // One-liner ops commands -> cheap; multi-step procedures -> balanced.
  {
    text: "Deploy the canary to staging",
    expectedClass: "ops",
    expectedTier: "cheap",
    note: "single command",
  },
  {
    text: "Scale the deployment to 5 replicas with kubectl",
    expectedClass: "ops",
    expectedTier: "cheap",
    note: "single command",
  },
  {
    text: "Run the terraform plan for staging",
    expectedClass: "ops",
    expectedTier: "cheap",
    note: "single command",
  },
  {
    text: "Set up the CI release pipeline for this repository. The workflow yaml should build the binary for linux and darwin, sign the artifacts with the release key, run the full test suite before publishing anything, then upload the signed artifacts to the GitHub release, and also open a PR that bumps the version file so the next cycle starts from the right commit; finally tag the release and push the changelog so the notes render on the tags page.",
    expectedClass: "ops",
    expectedTier: "balanced",
    note: "multi-step pipeline setup",
  },
  {
    text: "Apply the terraform changes for the new environment, then verify the resources in the cluster. First check what the diff changes in the VPC module and the database module, confirm the state lock is held for the whole apply, then run the apply and watch the output for drift warnings, and finally verify the DNS entries resolve before we send any traffic; if any step goes wrong, stop and write down the exact state we are in so recovery is fast.",
    expectedClass: "ops",
    expectedTier: "balanced",
    note: "guarded multi-step apply",
  },
  {
    text: "Investigate why the api deployment in the production cluster keeps restarting. Use kubectl to inspect the deployment status, the events, and the logs of the pods in the api namespace, check whether the last config change lowered the memory limits below what the startup path needs, then propose the fix and the exact kubectl commands to apply it safely during traffic, and finally confirm the pods stabilize before closing the incident.",
    expectedClass: "ops",
    expectedTier: "balanced",
    note: "live incident triage",
  },
  {
    text: "Rotate the TLS certificates on the ingress in the production cluster with kubectl, without downtime. First check which certificates expire this week and which secrets reference them, generate the new certificates into staging secrets, then patch the ingress with kubectl to reference the new secrets one at a time, and finally clean up the old secrets only after confirming the new ones serve traffic; note each command you run in the runbook as you go.",
    expectedClass: "ops",
    expectedTier: "balanced",
    note: "zero-downtime rotation procedure",
  },
  {
    text: "Triage why the CI pipeline job is flaky. Pull the last twenty runs from the pipeline and group them by symptom and by test name, then check whether the flaky runs correlate with peak queue hours or with the build cache being cold, and finally propose whether we should retry, quarantine, or fix the flaky set; include the evidence for each option and the expected effort so we can decide quickly, and note anything the pipeline logs already tell us that I am missing.",
    expectedClass: "ops",
    expectedTier: "balanced",
    note: "data-driven flakiness diagnosis",
  },

  /* ---------------------------- code_write --------------------------- */
  // Single-concern implementation -> balanced (floored); multi-file
  // features with several steps -> powerful.
  {
    text: "Implement a rate limiter in src/api/middleware.go",
    expectedClass: "code_write",
    expectedTier: "balanced",
    note: "single module, code class floor",
  },
  {
    text: "Add a /healthz endpoint to the server",
    expectedClass: "code_write",
    expectedTier: "balanced",
    note: "small feature, code class floor",
  },
  {
    text: "Write a function to parse ISO8601 durations in src/util/duration.ts",
    expectedClass: "code_write",
    expectedTier: "balanced",
    note: "single function, code class floor",
  },
  {
    text: "Create a CLI subcommand for exporting metrics",
    expectedClass: "code_write",
    expectedTier: "balanced",
    note: "single feature, code class floor",
  },
  {
    text: "Add pagination to the list endpoints. Change the handlers in src/api/handlers/users.ts and src/api/handlers/orders.ts to accept page and pageSize parameters, update the query builder in src/db/query.ts to apply the limit and offset, then add cursor support for stable ordering, and finally update the response envelope in src/api/response.ts to include next and previous links so clients can navigate without constructing URLs themselves.",
    expectedClass: "code_write",
    expectedTier: "powerful",
    note: "4 files, multi-step",
  },
  {
    text: "Build a webhook receiver for GitHub events. It must verify HMAC signatures, parse the delivery headers, then dispatch each event type to a handler registered in src/webhooks/registry.ts, persist raw payloads to the audit table via src/db/audit.ts so deliveries can be replayed, and finally expose a retry queue in src/webhooks/retry.ts that reprocesses failures with backoff instead of dropping them on the floor.",
    expectedClass: "code_write",
    expectedTier: "powerful",
    note: "3 files, signing + dispatch + retries",
  },
  {
    text: "Implement the export pipeline for billing data. The collectors in src/billing/collect.ts gather usage rows per tenant, the transformer in src/billing/transform.ts must fold them into invoice line items with correct proration, then the writer in src/billing/write.ts uploads parquet files to the warehouse bucket, and finally the reconciler in src/billing/reconcile.ts compares warehouse totals against source-of-truth and reports drift; make every stage idempotent and resumable from a checkpoint.",
    expectedClass: "code_write",
    expectedTier: "powerful",
    note: "4 files, idempotency requirement",
  },
  {
    text: "Set up the plugin system for the CLI. Define the hook interfaces in src/plugins/types.ts, implement the loader in src/plugins/loader.ts that discovers plugins from node_modules and local paths, add a sandboxed executor in src/plugins/sandbox.ts that enforces timeout and memory limits, then wire a permission model in src/plugins/permissions.ts so plugins declare what they touch, and finally write example plugins under examples/ that exercise every hook.",
    expectedClass: "code_write",
    expectedTier: "powerful",
    note: "4 files, sandbox + permissions",
  },

  /* ------------------------------ debug ------------------------------ */
  // Undiagnosed failures -> balanced (floored); repro + multi-file root
  // cause + regression guard -> powerful.
  {
    text: "The login flow is broken, fix it",
    expectedClass: "debug",
    expectedTier: "balanced",
    note: "undiagnosed, code class floor",
  },
  {
    text: "The build fails with exit code 1 on CI but works locally",
    expectedClass: "debug",
    expectedTier: "balanced",
    note: "environment-dependent failure",
  },
  {
    text: "Users report 500 errors on login after the deploy",
    expectedClass: "debug",
    expectedTier: "balanced",
    note: "post-deploy regression report",
  },
  {
    text: "Fix the panic in the scheduler when the queue is empty",
    expectedClass: "debug",
    expectedTier: "balanced",
    note: "localized crash, code class floor",
  },
  {
    text: "Fix this crash: runtime error: index out of range [5] in src/scheduler/heap.go. The dump shows `goroutine 1 [running]` inside heap.swap, and it reproduces when the compaction job runs concurrently with enqueues; add a reproducing test first, then find the root cause under the lock in src/scheduler/heap.go and src/scheduler/queue.go, fix it without changing the public API, and finally run the race detector across the whole scheduler package to prove the fix.",
    expectedClass: "debug",
    expectedTier: "powerful",
    note: "stack trace, concurrency, 2 files",
  },
  {
    text: "The pod keeps crash looping with OOMKilled after the memory limit change. Diagnose whether the limit is simply too low or the process leaks: capture heap profiles from the running pod before it dies, compare them across restarts, then trace the allocations in src/indexer/batch.go, src/indexer/merge.go, and src/indexer/scheduler.go back to their callers, fix the leak or raise the limit with justification, and finally add a regression check that fails if resident memory grows across batches.",
    expectedClass: "debug",
    expectedTier: "powerful",
    note: "profiling + 3 files + regression guard",
  },
  {
    text: "ECONNREFUSED error when the worker connects to redis in staging. It started after the connection pool change: reproduce it by running the worker locally against the staging replica, capture the exact connection state at the failure point in src/queue/pool.go, then check whether the pool drains before the health check marks nodes ready in src/queue/health.go and src/queue/config.go, and fix the ordering; finally verify with a soak run that connections recover after a redis failover.",
    expectedClass: "debug",
    expectedTier: "powerful",
    note: "repro + ordering bug across 3 files",
  },
  {
    text: "This stack trace started after the upgrade, diagnose it: Traceback (most recent call last): File \"app/server.py\", line 88, in handle File \"app/router.py\", line 41, in dispatch. It only happens under load when the cache layer is cold; reproduce it with the load script, then find the recursion or unbounded growth in app/server.py and app/router.py and app/cache.py, fix the root cause, and finally add a guard test that would have caught this before production.",
    expectedClass: "debug",
    expectedTier: "powerful",
    note: "python traceback, load-dependent, 3 files",
  },

  /* ----------------------------- refactor ---------------------------- */
  // Local cleanups -> balanced (floored); cross-cutting restructures -> powerful.
  {
    text: "Extract the duplicated validation logic into src/lib/validate.ts",
    expectedClass: "refactor",
    expectedTier: "balanced",
    note: "single extraction, code class floor",
  },
  {
    text: "Rename ComputeResult to EvaluateResult everywhere",
    expectedClass: "refactor",
    expectedTier: "balanced",
    note: "mechanical rename, code class floor",
  },
  {
    text: "Simplify the nested callbacks in the auth flow",
    expectedClass: "refactor",
    expectedTier: "balanced",
    note: "local simplification, code class floor",
  },
  {
    text: "Deduplicate the three copies of the retry helper",
    expectedClass: "refactor",
    expectedTier: "balanced",
    note: "local dedup, code class floor",
  },
  {
    text: "Restructure the internal packages by domain instead of by layer. The current layout has the users feature split across src/handlers/users.ts, src/services/users.ts, and src/repositories/users.ts; move the code into src/domains/users/handler.ts, src/domains/users/service.ts, and src/domains/users/repo.ts, update every import path, keep the public API re-exported from the old locations for one release, then delete the old directories once nothing references them, and finally update the module boundaries in the lint config so the new structure stays enforced.",
    expectedClass: "refactor",
    expectedTier: "powerful",
    note: "repo-wide restructure, compat shim",
  },
  {
    text: "Clean up the god object in src/server/handlers.go. Split it into a request validator, a response writer, and a middleware chain in separate files under src/server/, extract the shared test fixtures into src/server/testutil.go so the new files can be tested independently, then migrate the existing callers in src/server/routes.go one by one keeping the diff reviewable, and finally delete the god object once the last caller is gone.",
    expectedClass: "refactor",
    expectedTier: "powerful",
    note: "split god object, 3 files, staged migration",
  },
  {
    text: "Convert the inheritance hierarchy to composition. The base controller in src/controllers/base.ts centralizes auth, logging, and rendering; extract each concern into a decorator that wraps controllers, adapt the concrete controllers in src/controllers/posts.ts and src/controllers/comments.ts to the new shape, keep behavior identical behind the same routes, then remove the base class, and finally summarize the migration steps for external plugins that subclass it today.",
    expectedClass: "refactor",
    expectedTier: "powerful",
    note: "pattern conversion, 3 files, external consumers",
  },
  {
    text: "Deduplicate the three separate retry implementations into one. There is a retry loop in src/http/client.go, another in src/db/pool.go, and a third in src/messaging/consumer.go, each with different backoff and jitter; build a single retry policy in src/lib/retry.go that covers all the cases, clean up each call site preserving its current semantics, then run the integration suite against each consumer, and finally delete the old implementations and their duplicated tests.",
    expectedClass: "refactor",
    expectedTier: "powerful",
    note: "consolidate 4 files, semantics preservation",
  },

  /* ------------------------------ test ------------------------------- */
  // Single-suite additions -> balanced (floored); suites spanning files
  // with CI wiring -> powerful.
  {
    text: "Add unit tests for the config parser edge cases",
    expectedClass: "test",
    expectedTier: "balanced",
    note: "one suite, code class floor",
  },
  {
    text: "Write e2e tests for the login flow with Playwright",
    expectedClass: "test",
    expectedTier: "balanced",
    note: "one flow, code class floor",
  },
  {
    text: "Increase coverage for src/core/policy.ts",
    expectedClass: "test",
    expectedTier: "balanced",
    note: "coverage gap filling, code class floor",
  },
  {
    text: "Add a test that reproduces issue #342 and locks in the fix",
    expectedClass: "test",
    expectedTier: "balanced",
    note: "regression lock-in, code class floor",
  },
  {
    text: "Write table-driven tests for the transformer. Cover every input shape in src/transform/inputs.ts: the happy path, malformed records, unicode edge cases, and empty batches; use the fixture builder in src/transform/fixtures.ts to generate the test cases, assert on both the output rows and the failure channel, then check the suite passes with the strict spec matcher in src/transform/matchers.ts, and finally wire the new spec into the CI gate so it blocks merges when it regresses.",
    expectedClass: "test",
    expectedTier: "powerful",
    note: "3 files, table-driven, CI wiring",
  },
  {
    text: "Build the contract test suite for the payment provider. Record the real provider responses from the sandbox account into fixtures, then replay them against our client in src/payments/client.ts asserting on every field we depend on, add a drift check that flags when the provider schema changes, cover the retry and idempotency paths in src/payments/retry.ts and the webhook signatures in src/payments/types.ts with contract specs, and finally wire the whole spec suite to run on every release candidate so we catch contract breaks before deploy.",
    expectedClass: "test",
    expectedTier: "powerful",
    note: "contract suite, 3 files, drift detection",
  },
  {
    text: "Fix the test flakiness in the integration suite. The tests in test/integration/flow.test.ts fail about one run in five on CI: analyze whether the cause is shared database state, timing assumptions in the helpers from test/integration/helpers.ts, or port collisions between workers; stabilize them by isolating each spec in its own schema and replacing sleeps with event-based waits, use the fixtures in test/integration/fixtures.ts where possible, then run the suite fifty times locally to prove the flake is gone, and finally write down the concurrency rules the suite now assumes.",
    expectedClass: "test",
    expectedTier: "powerful",
    note: "flakiness hunt, 3 files, proof run",
  },
  {
    text: "Set up the performance guard tests for the routing hot path. Benchmark the classifier in bench/classifier.bench.ts against a corpus of realistic prompts, record the baseline p50 and p95 into bench/baselines.json, then fail the test suite in bench/hotpath.test.ts if the p95 drifts by more than ten percent, wire both into the CI pipeline so they run on every PR, and finally write a short runbook explaining how to interpret a failure and what to profile next.",
    expectedClass: "test",
    expectedTier: "powerful",
    note: "perf regression suite, 2 files, runbook",
  },

  /* --------------------------- architecture -------------------------- */
  // Focused tradeoff questions -> balanced (floored); multi-part system
  // design with rollout plans -> powerful.
  {
    text: "Should we adopt event sourcing for the billing service? Compare the tradeoffs",
    expectedClass: "architecture",
    expectedTier: "balanced",
    note: "single tradeoff question, class floor",
  },
  {
    text: "Evaluate monorepo vs polyrepo for our teams",
    expectedClass: "architecture",
    expectedTier: "balanced",
    note: "single tradeoff question, class floor",
  },
  {
    text: "Propose a caching strategy for the catalog service",
    expectedClass: "architecture",
    expectedTier: "balanced",
    note: "one subsystem, class floor",
  },
  {
    text: "Design the tenant isolation model",
    expectedClass: "architecture",
    expectedTier: "balanced",
    note: "one model, class floor",
  },
  {
    text: "Design the multi-region failover strategy for the platform. Map every stateful component — the primary database, the event bus, the search index, and the object storage — to its failover mode; compare active-active against active-passive per component on both cost and operational complexity, then write the escalation and data-reconciliation runbooks for the two scenarios we consider most likely, and finally propose the phased rollout order that lets us exit each phase safely if the metrics disagree with the plan.",
    expectedClass: "architecture",
    expectedTier: "powerful",
    note: "system-wide design + runbooks + rollout",
  },
  {
    text: "Plan the migration from REST to gRPC across the public API and evaluate every step of it. Inventory the fifty-two endpoints in the OpenAPI catalog and bucket them by traffic and churn, define the proto schema conventions and the status-code mapping in one place so teams do not diverge, then implement the transcoding gateway so old clients keep working during the transition, and finally set the deprecation timeline with usage-based carve-outs per endpoint so no major customer breaks without warning; also decide what we do about browser clients that cannot speak gRPC, and how should versioning work during the overlap?",
    expectedClass: "architecture",
    expectedTier: "powerful",
    note: "API-wide migration plan with compat",
  },
  {
    text: "Compare the tradeoffs of strong versus eventual consistency for the shopping cart service. Model the failure modes users actually hit — double charges on retries, ghost items after a failover, stale inventory at checkout — then evaluate how each consistency option changes those modes, quantify the implementation cost across the order service, the cart service, and the payment gateway, and finally recommend one option with the migration sequence and the metrics that would tell us we were wrong; what would change your recommendation?",
    expectedClass: "architecture",
    expectedTier: "powerful",
    note: "cross-service consistency analysis",
  },
  {
    text: "Architect the ingestion pipeline for fifty thousand events per second. Compare a managed stream service against self-hosted brokers on cost at our scale and on operational burden; design the partitioning key so consumer lag during replays stays bounded, define the schema registry and compatibility rules so producers can evolve safely, then plan the backpressure behavior when downstream sinks slow down, and finally sketch the observability we need to detect data loss within minutes rather than days; which parts would you prototype first?",
    expectedClass: "architecture",
    expectedTier: "powerful",
    note: "high-scale pipeline design + prototyping plan",
  },
]
