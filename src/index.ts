/**
 * OpenCode plugin entry.
 *
 * Registers the adaptive router:
 *
 *   - `session.hook("prompt")`  — routes each admitted prompt to the model
 *     the policy picks, by switching the session model before OpenCode
 *     resolves it for the turn.
 *   - `session.hook("retry")`   — may escalate to a stronger model when a
 *     provider failure looks survivable.
 *   - `/router [report|stats|status]` — telemetry and seam-verification
 *     report, delivered as a synthetic message (no model call, no routing).
 *
 * Configure via plugin options; see config.example.jsonc and README.md.
 */

import { Plugin } from "@opencode/plugin"
import { OpencodeHost, type OpencodeCtx } from "./adapters/opencode"
import { RouterEngine } from "./router"

export default Plugin.define({
  id: "adaptive-router",
  async setup(ctx) {
    const host = new OpencodeHost(ctx as unknown as OpencodeCtx)
    const engine = new RouterEngine(host, (ctx as { options?: unknown }).options)
    await engine.init()

    const promptHook = await ctx.session.hook("prompt", (event) => {
      const files = Array.isArray(event.prompt.files) ? event.prompt.files : []
      return engine.handlePromptAdmission({
        sessionID: event.sessionID,
        text: event.prompt.text,
        attachmentCount: files.length,
        setText: (text) => {
          event.prompt.text = text
        },
      })
    })

    const retryHook = await ctx.session.hook("retry", (event) => {
      return engine.handleRetry({
        sessionID: event.sessionID,
        model: event.model,
        attempt: event.attempt,
        error: event.error,
        acceptRetry: (delayMs) => {
          event.decision = { retry: true, delay: delayMs }
        },
        vetoRetry: () => {
          event.decision = { retry: false }
        },
      })
    })

    const commandReg = await ctx.command.transform((editor) => {
      editor.add({
        name: "router",
        description: "Adaptive router: report (default), stats, or status",
        execute: async ({ sessionID, prompt }) => {
          const arg = (prompt.text ?? "").trim()
          const text = arg.length === 0 ? engine.runCommand("report") : engine.runCommand(arg)
          await ctx.session.synthetic({ sessionID, text })
        },
      })
    })

    return () => {
      void promptHook.dispose()
      void retryHook.dispose()
      void commandReg.dispose()
      engine.dispose()
      host.abort()
    }
  },
})
