/**
 * Rule-based prompt analyzer and classifier.
 *
 * Phase 1 is deliberately deterministic: regex/keyword signals, session
 * context, and repo state in; `Classification` out. No network calls, no
 * latency, no cost. The output shape (`Classification`) is exactly what a
 * future learned classifier (local Qwen, EWMA stats) will produce, so the
 * engine will not change when the classifier does.
 */

import type {
  ComplexityBand,
  PromptAnalysis,
  PromptFeatures,
  Classification,
  SessionSnapshot,
  TaskClass,
} from "./types"

/* ------------------------------------------------------------------ *
 * Feature extraction
 * ------------------------------------------------------------------ */

const CODE_FENCE = /```/g
const INLINE_CODE = /`[^`\n]+`/g
const FILE_PATH =
  /(?:\.\.?\/|\/|~\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z]{1,8}\b/g
const URL = /https?:\/\/\S+/g
const IMPERATIVES =
  /\b(implement|write|create|add|build|make|fix|refactor|rename|extract|remove|delete|update|change|migrate|generate|scaffold|set\s?up|install|configure|document|deploy|test|review|explain|analy[sz]e|debug|diagnose)\b/gi
const MULTI_STEP =
  /\b(then|after that|next|also|additionally|first(?:ly)?|second(?:ly)?|finally|lastly|step \d)\b/gi
const STACKTRACE =
  /(traceback|stack\s?trace|at [\w$.]+\(.*:\d+:\d+\)|goroutine \d+|panic:|Segmentation fault|core dumped|exception in thread|node:internal\/|Trace\/back \(most recent call last\))/i
const ERROR_CODE =
  /\b(error|errno|exit code|failed|failure|cannot|can't|fatal|ECONNREFUSED|EINVAL|ENOENT|OOMKilled|CrashLoopBackOff|429|500|502|503|504)\b/i
const IDENTIFIER =
  /(?:`[^`\n]+`|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z0-9_]{3,}\b)/g

function countMatches(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  const matches = text.match(g)
  return matches ? matches.length : 0
}

export function extractFeatures(text: string, attachmentCount = 0): PromptFeatures {
  const trimmed = text.trim()
  return {
    charCount: text.length,
    wordCount: trimmed ? trimmed.split(/\s+/).length : 0,
    estTokens: Math.max(1, Math.ceil(text.length / 4)),
    codeFenceCount: Math.floor(countMatches(text, CODE_FENCE) / 2),
    inlineCodeCount: countMatches(trimmed, INLINE_CODE),
    filePathRefCount: countMatches(text, FILE_PATH),
    urlCount: countMatches(text, URL),
    questionCount: countMatches(text, /\?/g),
    imperativeCount: countMatches(trimmed, IMPERATIVES),
    bulletLineCount: countMatches(text, /^\s*(?:[-*+]|\d+[.)])\s+/gm),
    hasStacktrace: STACKTRACE.test(text),
    hasErrorCode: ERROR_CODE.test(text),
    multiStepMarkers: countMatches(trimmed, MULTI_STEP),
    identifierDensity: countMatches(trimmed, IDENTIFIER),
    attachmentCount,
  }
}

/* ------------------------------------------------------------------ *
 * Session snapshot
 * ------------------------------------------------------------------ */

export function emptySession(): SessionSnapshot {
  return { messageCount: 0, estTokens: 0, hasRecentError: false, recentUserTexts: [] }
}

/* ------------------------------------------------------------------ *
 * Task classification
 * ------------------------------------------------------------------ */

interface ClassRule {
  cls: TaskClass
  weight: number
  /** Matched keyword count contributes to confidence. */
  pattern: RegExp
  /** Evidence label in logs. */
  label: string
}

const CLASS_RULES: readonly ClassRule[] = [
  // Order matters for ties: review before debug ("critique the exception
  // handling" is a review), docs before code_write ("write the migration
  // guide" is docs), and debug leads the code classes.
  { cls: "review", weight: 3, pattern: /\b(review|critique|look\s?over|check\s?my|feedback|pull\s?request|\bpr\b|diff)\b/gi, label: "review language" },
  { cls: "debug", weight: 3, pattern: /\b(errors?|bugs?|fails?|failing|failures?|crash(?:es|ed|ing)?|broken|regressions?|stack\s?traces?|tracebacks?|panics?|exceptions?|not working|doesn't work|exit code)\b/gi, label: "failure language" },
  { cls: "docs", weight: 3, pattern: /\b(document|documentation|readme|docstring|changelog|guides?|runbooks?|comment)\b/gi, label: "docs language" },
  { cls: "code_write", weight: 2, pattern: /\b(implement|write|create|add|build|make|scaffold|set\s?up|generate)\b/gi, label: "construction verbs" },
  { cls: "refactor", weight: 3, pattern: /\b(refactor|rename|extract|clean\s?up|simplify|restructure|deduplicate|dedupe|tidy)\b/gi, label: "refactor language" },
  { cls: "test", weight: 3, pattern: /\b(tests?|spec|specs|coverage|unit\s?test|e2e|pytest|jest|vitest|ginkgo|go\s?test)\b/gi, label: "test language" },
  { cls: "architecture", weight: 3, pattern: /\b(design|architect(?:ure)?|trade-?offs?|should\swe|compare|evaluate|migration\s?plan|strategy|pros\sand\scons|plan)\b/gi, label: "design language" },
  { cls: "explain", weight: 3, pattern: /\b(explain|what\sdoes|how\sdoes|why\sdoes|walk\sme|tell\sme\sabout|what\sis|how\sdoes|understand|meaning\sof)\b/gi, label: "question language" },
  { cls: "ops", weight: 2, pattern: /\b(deploy|kubectl|helm|docker|podman|cluster|pipeline|ci\b|manifest|yaml|terraform|ansible)\b/gi, label: "ops language" },
]

const CHAT_PATTERN = /^(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|nice|great|sure)\b/i
const FOLLOWUP_PRONOUNS = /\b(it|that|this|those|these|there)\b/i

/** Imperative leads that mark a short prompt as an ops command. */
const OPS_COMMAND_LEAD =
  /^\s*(deploy|redeploy|restart|roll(?:out|back)|scale|rotate|provision|drain|cordon|apply|run|exec|kubectl|helm|terraform|docker|podman)\b/i

/** Imperative leads that mark a weak-signal prompt as a build request. */
const CONSTRUCTION_LEAD =
  /^\s*(implement|write|create|add|build|make|generate|scaffold|set\s?up)\b/i

interface ClassScore {
  cls: TaskClass
  score: number
  signals: string[]
}

function scoreClasses(analysis: PromptAnalysis, lastClass?: TaskClass): ClassScore[] {
  const { features, text, session } = analysis
  const scores = new Map<TaskClass, ClassScore>()
  const bump = (cls: TaskClass, amount: number, signal: string) => {
    const entry = scores.get(cls) ?? { cls, score: 0, signals: [] }
    entry.score += amount
    entry.signals.push(signal)
    scores.set(cls, entry)
  }

  for (const rule of CLASS_RULES) {
    const n = countMatches(text, rule.pattern)
    if (n > 0) bump(rule.cls, rule.weight * Math.min(n, 3), rule.label)
  }

  // Structural evidence
  if (features.codeFenceCount > 0 || features.inlineCodeCount >= 2) {
    bump("code_write", 2, "code in prompt")
  }
  if (features.hasStacktrace) bump("debug", 4, "stack trace")
  else if (features.hasErrorCode) bump("debug", 2, "error text")
  if (features.filePathRefCount > 0) bump("code_write", 2, "file paths")
  if (features.identifierDensity >= 6) bump("code_write", 1, "identifier density")
  if (features.questionCount >= 1 && features.imperativeCount === 0) {
    bump("explain", 2, "question only")
  }
  if (CHAT_PATTERN.test(text.trim()) && features.wordCount <= 6) {
    bump("chat", 4, "greeting/ack")
  }

  // Short imperative ops commands ("deploy the canary to staging") carry a
  // single weak keyword; without a nudge they fall through to chat.
  if (features.wordCount <= 12 && scores.get("ops") !== undefined && OPS_COMMAND_LEAD.test(text.trim())) {
    bump("ops", 2, "ops command form")
  }

  // Follow-up: short pronoun-led prompt over an existing session continues
  // the previous activity rather than starting a new one.
  const isFollowup =
    session.messageCount > 0 &&
    features.wordCount <= 12 &&
    !features.hasStacktrace &&
    features.codeFenceCount === 0 &&
    FOLLOWUP_PRONOUNS.test(text)
  if (isFollowup && lastClass) {
    bump(lastClass, 4, "follow-up continuation")
  }

  return [...scores.values()].sort((a, b) => b.score - a.score)
}

/* ------------------------------------------------------------------ *
 * Complexity scoring
 * ------------------------------------------------------------------ */

const BAND_THRESHOLDS: readonly [number, ComplexityBand][] = [
  [0.2, "trivial"],
  [0.4, "simple"],
  [0.6, "moderate"],
  [0.8, "complex"],
  [Number.POSITIVE_INFINITY, "very_complex"],
]

const CLASS_COMPLEXITY_PRIOR: Record<TaskClass, number> = {
  architecture: 0.18,
  code_write: 0.1,
  debug: 0.1,
  refactor: 0.1,
  review: 0.05,
  test: 0.05,
  ops: 0.05,
  explain: 0,
  docs: 0,
  chat: -0.15,
}

const CLASS_OUTPUT_TOKENS: Record<TaskClass, number> = {
  code_write: 1800,
  debug: 1500,
  refactor: 1500,
  test: 1200,
  review: 1200,
  architecture: 2000,
  explain: 800,
  docs: 1000,
  ops: 800,
  chat: 300,
}

const BAND_OUTPUT_MULTIPLIER: Record<ComplexityBand, number> = {
  trivial: 0.35,
  simple: 0.6,
  moderate: 1,
  complex: 1.6,
  very_complex: 2.2,
}

function complexityScore(
  analysis: PromptAnalysis,
  cls: TaskClass,
): { score: number; signals: string[] } {
  const { features, session } = analysis
  const signals: string[] = []
  let score = 0.12 // baseline: any agent turn does real work

  if (features.estTokens > 600) {
    score += 0.35
    signals.push("long prompt")
  } else if (features.estTokens > 300) {
    score += 0.25
    signals.push("medium prompt")
  } else if (features.estTokens > 100) {
    score += 0.15
  }

  if (features.codeFenceCount >= 2) {
    score += 0.2
    signals.push("multiple code blocks")
  } else if (features.codeFenceCount === 1) {
    score += 0.1
  }

  if (features.hasStacktrace) {
    score += 0.2
    signals.push("stack trace to diagnose")
  }

  if (features.filePathRefCount >= 3) {
    score += 0.15
    signals.push("many file references")
  } else if (features.filePathRefCount >= 1) {
    score += 0.08
  }

  if (features.questionCount >= 4) {
    score += 0.2
    signals.push("many questions")
  } else if (features.questionCount >= 2) {
    score += 0.1
  }

  if (features.multiStepMarkers >= 2) {
    score += 0.15
    signals.push("multi-step request")
  } else if (features.multiStepMarkers === 1) {
    score += 0.07
  }

  if (session.estTokens > 60_000) {
    score += 0.25
    signals.push("large session context")
  } else if (session.estTokens > 20_000) {
    score += 0.15
    signals.push("grown session context")
  }

  if (session.hasRecentError) {
    score += 0.08
    signals.push("recent error in session")
  }

  const attachments = Math.min(features.attachmentCount, 3)
  if (attachments > 0) {
    score += 0.05 * attachments
    signals.push(`${attachments} attachment(s)`)
  }

  const prior = CLASS_COMPLEXITY_PRIOR[cls]
  if (prior !== 0) score += prior

  return { score: clamp01(score), signals }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function bandFor(score: number): ComplexityBand {
  for (const [threshold, band] of BAND_THRESHOLDS) {
    if (score < threshold) return band
  }
  return "very_complex"
}

/* ------------------------------------------------------------------ *
 * Classification entry point
 * ------------------------------------------------------------------ */

export interface ClassifyOptions {
  /** Task class the router inferred for this session's previous turn. */
  lastClass?: TaskClass
}

export function classify(analysis: PromptAnalysis, options: ClassifyOptions = {}): Classification {
  const ranked = scoreClasses(analysis, options.lastClass)
  const best = ranked[0]

  let taskClass: TaskClass
  let classSignals: string[]
  if (best && best.score >= 3) {
    taskClass = best.cls
    classSignals = best.signals
  } else if (analysis.features.questionCount > 0) {
    taskClass = "explain"
    classSignals = ["question, weak class signals"]
  } else if (CONSTRUCTION_LEAD.test(analysis.text.trim()) && analysis.features.imperativeCount >= 1) {
    // "Add a /healthz endpoint" carries one weak construction verb — not
    // enough to win scoring, but clearly a build request, not chat.
    taskClass = "code_write"
    classSignals = ["imperative construction request"]
  } else if (analysis.session.messageCount > 0) {
    taskClass = options.lastClass ?? "code_write"
    classSignals = ["weak signals, continuing session activity"]
  } else {
    taskClass = "chat"
    classSignals = ["weak signals"]
  }

  const { score, signals } = complexityScore(analysis, taskClass)
  const band = bandFor(score)

  // Confidence: how strongly the evidence converged.
  const runnerUp = ranked[1]?.score ?? 0
  const margin = best ? best.score - runnerUp : 0
  const confidence = clamp01(
    0.35 +
      Math.min(0.4, margin * 0.08) +
      (best ? Math.min(0.15, best.score * 0.02) : 0) +
      signals.length * 0.02,
  )

  const estOutputTokens = Math.round(
    CLASS_OUTPUT_TOKENS[taskClass] * BAND_OUTPUT_MULTIPLIER[band],
  )

  return {
    taskClass,
    complexity: score,
    band,
    confidence,
    signals: [...classSignals, ...signals],
    estOutputTokens,
  }
}
