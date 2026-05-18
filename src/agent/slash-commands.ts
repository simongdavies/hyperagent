// ── agent/slash-commands.ts — Slash command handlers ─────────────────
//
// Extracted from agent.ts. Contains handleSlashCommand() and its
// dependencies. All runtime singletons are passed via SlashCommandDeps.
// ─────────────────────────────────────────────────────────────────────

// Note: This file no longer imports `node:readline/promises` — modal input
// flows entirely through the `AgentUI` port. The `pluginManager.promptConfig`
// + paste-buffer-drain migrations (Phase 3c/3d) removed the last call sites
// that needed a raw readline handle.
import type { CopilotSession, ModelInfo } from "@github/copilot-sdk";
import type { WriteStream } from "node:fs";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { C } from "./ansi.js";
import type { AgentState } from "./state.js";
import type { AgentUI } from "./ui/index.js";
import { renderHelp, renderTopicHelp } from "./commands.js";
import { deepAudit, formatAuditResult } from "../plugin-system/auditor.js";
import { makeAuditProgressCallback } from "./audit-progress.js";
import { createAuditAbortHandler } from "./abort-controller.js";
import { renderMarkdown } from "./markdown-renderer.js";
import { closestMatch } from "./fuzzy-match.js";
import type { createSandboxTool } from "../sandbox/tool.js";
import type { createPluginManager } from "../plugin-system/manager.js";
import type { Transcript } from "./transcript.js";
import {
  contentHash,
  loadOperatorConfig,
  exceedsRiskThreshold,
} from "../plugin-system/manager.js";
import type { MCPClientManager } from "./mcp/client-manager.js";
import {
  loadMCPApprovalStore,
  isMCPApproved,
  approveMCPServer,
  revokeMCPApproval,
  auditMCPTools,
} from "./mcp/approval.js";
import { maskEnvValue } from "./mcp/sanitise.js";
import { canAcquireSilently } from "./mcp/auth/msal-oauth.js";
import {
  isMCPHttpConfig,
  isMCPStdioConfig,
  mcpConfigDisplayString,
} from "./mcp/types.js";
import {
  createMCPPluginAdapter,
  generateMCPDeclarations,
} from "./mcp/plugin-adapter.js";
import {
  listUserSkills,
  readUserSkill,
  deleteUserSkill,
  userSkillExists,
  systemSkillExists,
  getUserSkillsDir,
  validateSkillName,
} from "./skill-writer.js";
import {
  extractSessionContext,
  renderSessionContext,
} from "./session-context.js";
import { resolveFileAttachment } from "./attachments.js";

// ── Constants ────────────────────────────────────────────────────────

const SESSION_ID_PREFIX = "hyperagent-";
const SESSIONS_PAGE_SIZE = 10;
function makeSessionId(): string {
  return `${SESSION_ID_PREFIX}${randomUUID()}`;
}
const operatorConfig = loadOperatorConfig();

/**
 * Convert formatConfigSummary lines into a markdown table.
 * Lines have format "  key: value" or "  key: value (default)".
 */
function formatConfigTable(lines: string[]): string {
  const rows = lines.map((line) => {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) return `| ${trimmed} | |`;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    return `| ${key} | ${value} |`;
  });
  return `| Key | Value |\n|-----|-------|\n${rows.join("\n")}`;
}

// ── Types ────────────────────────────────────────────────────────────

/** Runtime dependencies injected from agent.ts */
export interface SlashCommandDeps {
  state: AgentState;
  ui: AgentUI;
  sandbox: ReturnType<typeof createSandboxTool>;
  pluginManager: ReturnType<typeof createPluginManager>;
  transcript: Transcript;
  SEND_TIMEOUT_MS: number;
  debugLog: (msg: string) => void;
  debugStream: WriteStream | null;
  setDebugStream: (stream: WriteStream) => void;
  LOGS_DIR: string;
  formatModelList: (models: ModelInfo[], current?: string) => string;
  buildSessionConfig: () => Record<string, unknown>;
  registerEventHandler: (session: CopilotSession) => void;
  /** MCP client manager (null if MCP plugin not enabled). */
  mcpManager: MCPClientManager | null;
  /** Callback to sync plugins to sandbox after MCP changes. */
  syncPlugins: () => Promise<void>;
  /**
   * Queue a synthetic prompt for the LLM (used by `/save-skill` and
   * similar commands that want to inject a user-turn-shaped message).
   * The prompt is drained at the top of the next REPL iteration.
   *
   * `options.skipAutoSuggest` suppresses the automatic
   * `runSuggestApproach` pass on the next turn — synthetic prompts
   * contain scaffolding text (e.g. "MCP", "SKILL.md") that would
   * otherwise match unrelated skill triggers.
   */
  submitToLLM: (
    prompt: string,
    options?: { skipAutoSuggest?: boolean },
  ) => void;
}

// ── Handler ──────────────────────────────────────────────────────────

/**
 * Handle a slash command from the REPL.
 *
 * @returns true if the input was handled as a command,
 *          false if it should be forwarded to the LLM.
 */
export async function handleSlashCommand(
  rawInput: string,
  deps: SlashCommandDeps,
): Promise<boolean> {
  // Destructure deps so the function body can reference them
  // by their original names — zero code changes in the switch block.
  const {
    state,
    ui,
    sandbox,
    pluginManager,
    transcript,
    SEND_TIMEOUT_MS,
    debugLog,
    LOGS_DIR,
  } = deps;
  // Alias deps that shadow variables in agent.ts
  let { debugStream } = deps;
  const formatModelList = deps.formatModelList;
  const buildSessionConfig = deps.buildSessionConfig;
  const registerEventHandler = deps.registerEventHandler;
  const parts = rawInput.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // ── Local notification helpers ─────────────────────────────────────
  //
  // Convenience wrappers around `ui.emitNotification` so the dispatcher
  // body stays readable. Each helper produces a structured payload that
  // a JsonLines (or other non-terminal) UI can route on `kind` / `level`;
  // the verbose call-site form is still available for one-off shapes.
  //
  //   - `note(message)`            \u2192 default block-indented "plain" line
  //                                  (the most common slash-command output)
  //   - `noteIcon(icon, message)`  \u2192 same, with a leading icon + space
  //   - `noteRaw(message)`         \u2192 verbatim message, no indent injection
  //   - `blank()`                  \u2192 single newline (legacy `console.log()`)
  //   - `warn` / `err` / `ok`      \u2192 semantic level shortcuts whose color
  //                                  wraps the whole rendered line
  //
  // `kind: "generic"` is used throughout; specific surfaces (plugin / mcp /
  // skills / etc.) can carry their own `kind` via direct `ui.emitNotification`
  // calls where the structural tag is useful for downstream routing.

  /** Block-indented plain-level line. Equivalent to `console.log("  " + msg)` */
  const note = (message: string): void => {
    ui.emitNotification({ level: "plain", kind: "generic", message });
  };
  /** Block-indented line with an icon prefix. */
  const noteIcon = (icon: string, message: string): void => {
    ui.emitNotification({ level: "plain", kind: "generic", icon, message });
  };
  /** Verbatim line (no indent injection). Used for hand-formatted blocks. */
  const noteRaw = (message: string): void => {
    ui.emitNotification({
      level: "plain",
      kind: "generic",
      indent: "",
      message,
    });
  };
  /** Single newline spacer. Equivalent to legacy `console.log()`. */
  const blank = (): void => noteRaw("");
  /** Warning-coloured line (whole line yellow) with default `\u26a0\ufe0f` icon. */
  const warn = (message: string, icon: string = "\u26a0\ufe0f"): void => {
    ui.emitNotification({ level: "warning", kind: "generic", icon, message });
  };
  /** Error-coloured line (whole line red) with default `\u274c` icon. */
  const err = (message: string, icon: string = "\u274c"): void => {
    ui.emitNotification({ level: "error", kind: "generic", icon, message });
  };
  /** Success-coloured line (whole line green) with default `\u2705` icon. */
  const ok = (message: string, icon: string = "\u2705"): void => {
    ui.emitNotification({ level: "success", kind: "generic", icon, message });
  };

  switch (cmd) {
    case "/show-code":
      state.showCodeEnabled = !state.showCodeEnabled;
      noteIcon("📝", `Code display: ${C.onOff(state.showCodeEnabled)}`);
      blank();
      return true;

    case "/show-timing":
      state.showTimingEnabled = !state.showTimingEnabled;
      // Variation-selector watch glyph aligns with an extra trailing
      // space (folded into the icon arg so the rendered bytes match).
      noteIcon("⏱️ ", `Timing display: ${C.onOff(state.showTimingEnabled)}`);
      blank();
      return true;

    case "/debug":
      state.debugEnabled = !state.debugEnabled;
      if (state.debugEnabled && !debugStream) {
        // Create log file on first enable
        mkdirSync(LOGS_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const path = join(LOGS_DIR, `agent-debug-${ts}.log`);
        const newStream = createWriteStream(path, { flags: "a" });
        // Update BOTH the local variable AND the module-level stream
        // in agent.ts via the callback — otherwise debugLog() in the
        // event handler still uses the old (null) stream.
        debugStream = newStream;
        deps.setDebugStream(newStream);
        noteIcon("🔍", `Debug mode: ${C.ok("ON")}`);
        noteIcon("📝", `Debug log: ${path}`);
      } else {
        noteIcon("🔍", `Debug mode: ${C.onOff(state.debugEnabled)}`);
      }
      blank();
      return true;

    case "/tokens": {
      const { formatTokenSummary } = await import("./llm-output.js");
      const lines = formatTokenSummary(state);
      for (const line of lines) {
        // Pre-formatted lines from `formatTokenSummary` — emit
        // verbatim with the canonical block indent.
        note(line);
      }
      blank();
      return true;
    }

    case "/reasoning": {
      // /reasoning conversation <level> — set conversation reasoning effort
      // /reasoning audit <level>        — set audit reasoning effort (min: medium)
      // /reasoning                      — show current settings
      const subCmd = parts[1]?.toLowerCase();

      if (subCmd === "conversation" || subCmd === "conv") {
        const level = parts[2]?.toLowerCase();
        const VALID = ["low", "medium", "high", "xhigh"] as const;
        type Effort = (typeof VALID)[number];

        if (level && VALID.includes(level as Effort)) {
          // Validate current model supports reasoning effort
          if (state.cachedModels) {
            const model = state.cachedModels.find(
              (m) => m.id === state.currentModel,
            );
            if (model && !model.capabilities?.supports?.reasoningEffort) {
              // Original line was uncoloured outside of `C.val(...)`;
              // emit through `note(...)` with the warning glyph embedded
              // so the bytes match (no full-line yellow wrap).
              note(
                `⚠️  ${C.val(state.currentModel)} doesn't support reasoning effort`,
              );
              blank();
              return true;
            }
          }
          state.reasoningEffort = level as Effort;
          state.sessionNeedsRebuild = true;
          noteIcon(
            "🧠",
            `Conversation reasoning: ${C.val(level)} ${C.dim("(rebuild on next message)")}`,
          );
        } else if (level === "reset" || level === "off") {
          state.reasoningEffort = null;
          state.sessionNeedsRebuild = true;
          noteIcon(
            "🧠",
            `Conversation reasoning: ${C.dim("model default (reset)")}`,
          );
        } else {
          noteIcon(
            "🧠",
            `Conversation reasoning: ${
              state.reasoningEffort
                ? C.val(state.reasoningEffort)
                : C.dim("model default")
            }`,
          );
          note(
            `Usage: /reasoning conversation <level>  ${C.dim("— low|medium|high|xhigh")}`,
          );
          note(
            `       /reasoning conversation reset    ${C.dim("— use model default")}`,
          );
        }
      } else if (subCmd === "audit") {
        const level = parts[2]?.toLowerCase();
        const VALID_AUDIT = ["medium", "high", "xhigh"] as const;
        type AuditEffort = (typeof VALID_AUDIT)[number];

        if (level && VALID_AUDIT.includes(level as AuditEffort)) {
          state.auditReasoningEffort = level as AuditEffort;
          noteIcon("🔍", `Audit reasoning: ${C.val(level)}`);
        } else if (level === "reset" || level === "off") {
          state.auditReasoningEffort = null;
          noteIcon("🔍", `Audit reasoning: ${C.dim("medium (default)")}`);
        } else {
          noteIcon(
            "🔍",
            `Audit reasoning: ${
              state.auditReasoningEffort
                ? C.val(state.auditReasoningEffort)
                : C.dim("medium (default)")
            }`,
          );
          note(
            `Usage: /reasoning audit <level>  ${C.dim("— medium|high|xhigh (min: medium)")}`,
          );
          note(
            `       /reasoning audit reset    ${C.dim("— reset to medium")}`,
          );
        }
      } else {
        // No subcommand or unknown — show both settings + usage
        noteIcon(
          "🧠",
          `Conversation: ${
            state.reasoningEffort
              ? C.val(state.reasoningEffort)
              : C.dim("model default")
          }`,
        );
        noteIcon(
          "🔍",
          `Audit:        ${
            state.auditReasoningEffort
              ? C.val(state.auditReasoningEffort)
              : C.dim("medium (default)")
          }`,
        );
        blank();
        note(
          `Usage: /reasoning conversation <level>  ${C.dim("— low|medium|high|xhigh")}`,
        );
        note(
          `       /reasoning audit <level>         ${C.dim("— medium|high|xhigh (min: medium)")}`,
        );
      }
      blank();
      return true;
    }

    case "/verbose": {
      // Toggle verbose output mode — affects reasoning display,
      // turn lifecycle events, and other detailed LLM output.
      state.verboseOutput = !state.verboseOutput;
      ui.setVerboseReasoning(state.verboseOutput);
      noteIcon(
        "💡",
        `Verbose output: ${state.verboseOutput ? C.ok("ON") : C.err("OFF")}`,
      );
      blank();
      return true;
    }

    case "/markdown":
    case "/md": {
      // Subcommand dispatcher — bare invocation is a pure status query
      // that NEVER mutates state. Mutation requires an explicit verb
      // (on/off/toggle). This avoids the "I just wanted to check"
      // toggle-trap that flips state at inspection time.
      const sub = (parts[1] ?? "").toLowerCase();
      const prev = state.markdownEnabled;
      let next = prev;
      let unknown = false;

      if (sub === "" || sub === "status") {
        // Pure status query — leave state untouched.
      } else if (sub === "on" || sub === "true" || sub === "1") {
        next = true;
      } else if (sub === "off" || sub === "false" || sub === "0") {
        next = false;
      } else if (sub === "toggle") {
        next = !prev;
      } else {
        unknown = true;
      }

      if (unknown) {
        // Inline `C.warn("⚠️")` + double-space matches the legacy
        // `console.log("  ${C.warn("⚠️")}  Usage: …")` formatting.
        note(
          `${C.warn("⚠️")}  Usage: ${C.tool("/markdown [on|off|toggle|status]")} ${C.dim("(bare = status, never mutates)")}`,
        );
      } else {
        if (next !== prev) {
          state.markdownEnabled = next;
          // System prompt includes markdown-specific instructions
          // (OUTPUT mode, FILE REFERENCES). Rebuild so the LLM
          // gets the update on the next turn.
          state.sessionNeedsRebuild = true;
        }
        const detail = state.markdownEnabled
          ? C.ok("ON") + C.dim(" (output buffered, not streamed)")
          : C.err("OFF") + C.dim(" (raw streaming)");
        noteIcon("📝", `Markdown rendering: ${detail}`);
      }
      blank();
      return true;
    }

    case "/timeout": {
      const kind = parts[1]?.toLowerCase();
      const ms = parseInt(parts[2], 10);

      if (kind === "cpu" && Number.isFinite(ms) && ms > 0) {
        // Validate: CPU should be ≤ wall-clock (wall is the backstop)
        const effectiveWall =
          state.wallTimeoutOverride ?? sandbox.config.wallClockTimeoutMs;
        if (ms > effectiveWall) {
          note(
            `⚠️  CPU timeout (${ms}ms) > wall-clock (${effectiveWall}ms) — ` +
              `wall-clock will fire first, making CPU limit unreachable.`,
          );
        }
        state.cpuTimeoutOverride = ms;
        noteIcon("⏱️ ", `CPU timeout set to ${C.val(ms + "ms")}`);
      } else if (kind === "wall" && Number.isFinite(ms) && ms > 0) {
        // Validate: wall-clock should be ≥ CPU (wall is the backstop)
        const effectiveCpu =
          state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs;
        if (ms < effectiveCpu) {
          note(
            `⚠️  Wall-clock (${ms}ms) < CPU timeout (${effectiveCpu}ms) — ` +
              `wall-clock will fire first, making CPU limit unreachable.`,
          );
        }
        state.wallTimeoutOverride = ms;
        noteIcon("⏱️ ", `Wall-clock timeout set to ${C.val(ms + "ms")}`);
      } else if (kind === "send" && Number.isFinite(ms) && ms > 0) {
        // Send timeout — how long to wait for the agent to finish
        state.sendTimeoutOverride = ms;
        noteIcon("⏱️ ", `Send timeout set to ${C.val(ms + "ms")}`);
      } else if (kind === "reset") {
        state.cpuTimeoutOverride = null;
        state.wallTimeoutOverride = null;
        state.sendTimeoutOverride = null;
        noteIcon(
          "⏱️ ",
          `Timeouts reset to defaults ` +
            `(CPU: ${sandbox.config.cpuTimeoutMs}ms, ` +
            `Wall: ${sandbox.config.wallClockTimeoutMs}ms, ` +
            `Send: ${SEND_TIMEOUT_MS}ms)`,
        );
      } else {
        note("Usage: /timeout cpu|wall|send <ms>  or  /timeout reset");
      }
      blank();
      return true;
    }

    case "/buffer": {
      const kind = parts[1]?.toLowerCase();
      const kb = parseInt(parts[2], 10);

      if (kind === "input" && Number.isFinite(kb) && kb > 0) {
        state.inputBufferOverride = kb;
        await sandbox.setBufferSizes(kb, undefined);
        state.sessionNeedsRebuild = true;
        noteIcon(
          "📦",
          `Input buffer set to ${C.val(kb + "KB")} ${C.dim("(rebuild on next message)")}`,
        );
      } else if (kind === "output" && Number.isFinite(kb) && kb > 0) {
        state.outputBufferOverride = kb;
        await sandbox.setBufferSizes(undefined, kb);
        state.sessionNeedsRebuild = true;
        noteIcon(
          "📦",
          `Output buffer set to ${C.val(kb + "KB")} ${C.dim("(rebuild on next message)")}`,
        );
      } else if (kind === "reset") {
        state.inputBufferOverride = null;
        state.outputBufferOverride = null;
        await sandbox.resetBufferSizes();
        state.sessionNeedsRebuild = true;
        noteIcon(
          "📦",
          `Buffers reset to defaults ` +
            `(input: ${sandbox.config.inputBufferKb}KB, ` +
            `output: ${sandbox.config.outputBufferKb}KB)`,
        );
      } else {
        note("Usage: /buffer input|output <kb>  or  /buffer reset");
      }
      blank();
      return true;
    }

    case "/set": {
      const setSub = parts[1]?.toLowerCase();
      const setVal = parseInt(parts[2], 10);

      if (setSub === "heap") {
        if (Number.isFinite(setVal) && setVal > 0) {
          state.heapOverride = setVal;
          await sandbox.setMemorySizes(setVal, undefined);
          state.sessionNeedsRebuild = true;
          noteIcon(
            "🧠",
            `Heap set to ${C.val(setVal + "MB")} ${C.dim("(rebuild on next message)")}`,
          );
        } else {
          const current = sandbox.getEffectiveMemorySizes();
          note(
            `Current heap: ${C.val(current.heapMb + "MB")}${state.heapOverride !== null ? C.warn(" (overridden)") : ""}`,
          );
          note("Usage: /set heap <mb>  — e.g. /set heap 32");
        }
      } else if (setSub === "scratch") {
        if (Number.isFinite(setVal) && setVal > 0) {
          state.scratchOverride = setVal;
          await sandbox.setMemorySizes(undefined, setVal);
          state.sessionNeedsRebuild = true;
          noteIcon(
            "📚",
            `Scratch set to ${C.val(setVal + "MB")} ${C.dim("(rebuild on next message)")}`,
          );
        } else {
          const current = sandbox.getEffectiveMemorySizes();
          note(
            `Current scratch: ${C.val(current.scratchMb + "MB")}${state.scratchOverride !== null ? C.warn(" (overridden)") : ""}`,
          );
          note("Usage: /set scratch <mb>  — e.g. /set scratch 4");
        }
      } else if (setSub === "reset") {
        state.heapOverride = null;
        state.scratchOverride = null;
        await sandbox.resetMemorySizes();
        state.sessionNeedsRebuild = true;
        noteIcon(
          "🧠",
          `Memory reset to defaults ` +
            `(heap: ${sandbox.config.heapSizeMb}MB, ` +
            `scratch: ${sandbox.config.scratchSizeMb}MB)`,
        );
      } else {
        note("Usage: /set heap|scratch <mb>  or  /set reset");
      }
      blank();
      return true;
    }

    case "/transcript": {
      // Toggle transcript recording on/off.
      if (transcript.active) {
        const paths = await transcript.stop();
        noteIcon("📄", "Transcript stopped.");
        // Indented sub-lines under the stop notice. The legacy lines
        // were uncoloured 5-space indents — emit verbatim via `noteRaw`.
        noteRaw(`     ANSI log:  ${paths.logPath}`);
        noteRaw(`     Clean text: ${paths.txtPath}`);
      } else {
        const buffers = sandbox.getEffectiveBufferSizes();
        const logPath = transcript.start({
          model: state.currentModel,
          cpuTimeoutMs: state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs,
          wallClockTimeoutMs:
            state.wallTimeoutOverride ?? sandbox.config.wallClockTimeoutMs,
          heapSizeMb: sandbox.config.heapSizeMb,
          inputBufferKb: buffers.inputKb,
          outputBufferKb: buffers.outputKb,
        });
        noteIcon("📄", `Transcript started: ${logPath}`);
      }
      blank();
      return true;
    }

    case "/models": {
      // List available models from the Copilot API.
      if (!state.copilotClient) {
        note(`${C.err("❌ Client not connected.")}`);
        blank();
        return true;
      }
      try {
        const models = await state.copilotClient.listModels();
        state.cachedModels = models;
        // `formatModelList` returns a pre-rendered block including its
        // own embedded indents and blank lines — emit it whole via the
        // raw (zero-indent) helper.
        noteRaw(formatModelList(models, state.currentModel));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        note(`${C.err("❌ Failed to list models: " + msg)}`);
      }
      blank();
      return true;
    }

    case "/model": {
      // Switch model mid-session using session.setModel() — the SDK
      // handles everything server-side, no session rebuild needed.
      const newModel = parts[1];
      if (!newModel) {
        noteIcon("🤖", `Current model: ${C.val(state.currentModel)}`);
        note("Usage: /model <name>  (use /models to list available)");
        blank();
        return true;
      }
      if (!state.copilotClient || !state.activeSession) {
        note(`${C.err("❌ No active session.")}`);
        blank();
        return true;
      }
      // Validate model name against available models
      try {
        if (!state.cachedModels) {
          state.cachedModels = await state.copilotClient.listModels();
        }
        const valid = state.cachedModels.some((m) => m.id === newModel);
        if (!valid) {
          note(`${C.err("❌ Unknown model:")} "${newModel}"`);
          note("   Use /models to see available models.");
          blank();
          return true;
        }
        const disabled = state.cachedModels.find((m) => m.id === newModel);
        if (disabled?.policy?.state === "disabled") {
          note(
            `${C.warn("⚠️  Model")} "${newModel}" ${C.warn("is disabled by policy.")}`,
          );
        }
      } catch {
        // Validation failed — proceed anyway, server will reject if invalid
        note("⚠️  Could not validate model name — proceeding anyway.");
      }
      try {
        // Use session.setModel() — the SDK switches the model
        // server-side without tearing down the session or
        // re-registering handlers. History is preserved.
        const oldModel = state.currentModel;
        await state.activeSession.setModel(newModel);
        state.currentModel = newModel;
        note(
          `${C.ok("🔄 Model switched:")} ${C.dim(oldModel)} → ${C.val(state.currentModel)}`,
        );
        note("   Conversation history preserved.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        note(`${C.err("❌ Failed to switch model: " + msg)}`);
      }
      blank();
      return true;
    }

    case "/new": {
      // Start a fresh session — blank slate, same model.
      if (!state.copilotClient || !state.activeSession) {
        note(`${C.err("❌ No active session.")}`);
        blank();
        return true;
      }
      try {
        await state.activeSession.destroy();
        state.activeSession = await state.copilotClient.createSession({
          sessionId: makeSessionId(),
          model: state.currentModel,
          ...buildSessionConfig(),
        } as any);
        registerEventHandler(state.activeSession);
        // Reset session-learning fields — the new conversation starts
        // with no history of what we did last time, and the previous
        // user-prompt should not anchor /save-skill or auto-suggest on
        // the next turn either.
        state.toolCallHistory = [];
        state.mcpServersUsed = new Set();
        state.modulesRegistered = [];
        state.currentUserPrompt = "";
        state.lastGuidance = null;
        note(
          `${C.ok("🆕 New session started.")} Conversation history cleared.`,
        );
        note(`   Model: ${C.val(state.currentModel)}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        note(`${C.err("❌ Failed to create new session: " + msg)}`);
      }
      blank();
      return true;
    }

    case "/sessions": {
      // List saved hyperagent sessions (filtered by prefix, paginated).
      if (!state.copilotClient) {
        note(`${C.err("❌ Client not connected.")}`);
        blank();
        return true;
      }
      const showAll =
        parts.includes("--all") ||
        parts.includes("-a") ||
        parts.includes("-all");
      try {
        const allSessions = await state.copilotClient.listSessions();
        // Filter to only hyperagent-prefixed sessions
        const sessions = allSessions.filter((s) =>
          s.sessionId.startsWith(SESSION_ID_PREFIX),
        );
        if (sessions.length === 0) {
          note("📋 No saved hyperagent sessions found.");
          if (allSessions.length > 0) {
            note(
              `   ${C.dim(`(${allSessions.length} session${allSessions.length === 1 ? "" : "s"} from other Copilot clients hidden)`)}`,
            );
          }
        } else {
          // Sort newest first
          sessions.sort((a, b) => {
            const ta = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
            const tb = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
            return tb - ta;
          });

          const displayCount = showAll
            ? sessions.length
            : Math.min(sessions.length, SESSIONS_PAGE_SIZE);
          const hidden = sessions.length - displayCount;

          note(`${C.label("📋 Sessions")} (${sessions.length}):`);
          for (let i = 0; i < displayCount; i++) {
            const s = sessions[i];
            const current =
              state.activeSession &&
              s.sessionId === state.activeSession.sessionId
                ? ` ${C.ok("← current")}`
                : "";
            const modified = s.modifiedTime
              ? new Date(s.modifiedTime).toLocaleString()
              : "unknown";
            const summary = s.summary
              ? ` — ${s.summary.slice(0, 60)}${s.summary.length > 60 ? "…" : ""}`
              : "";
            // Show the full UUID part after the prefix so users can
            // paste it into /resume (partial matching works too).
            const uuidPart = s.sessionId.slice(SESSION_ID_PREFIX.length);
            note(`   ${C.val(uuidPart)}${current}`);
            note(`     ${C.dim("Modified:")} ${modified}${summary}`);
          }
          if (hidden > 0) {
            note(
              `   ${C.dim(`… ${hidden} more — use /sessions --all to show all`)}`,
            );
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        note(`${C.err("❌ Failed to list sessions: " + msg)}`);
      }
      blank();
      return true;
    }

    case "/resume": {
      // Resume a previous session.
      if (!state.copilotClient) {
        note(`${C.err("❌ Client not connected.")}`);
        blank();
        return true;
      }
      try {
        let targetId = parts[1];
        if (!targetId) {
          // No ID given — show interactive session picker (like az account list).
          const allSessions = await state.copilotClient.listSessions();
          const ours = allSessions
            .filter((s) => s.sessionId.startsWith(SESSION_ID_PREFIX))
            .sort((a, b) => {
              const ta = a.modifiedTime
                ? new Date(a.modifiedTime).getTime()
                : 0;
              const tb = b.modifiedTime
                ? new Date(b.modifiedTime).getTime()
                : 0;
              return tb - ta;
            });
          if (ours.length === 0) {
            note(`${C.err("❌ No previous hyperagent sessions found.")}`);
            blank();
            return true;
          }

          // Show numbered list (max 20 most recent)
          const pickCount = Math.min(ours.length, 20);
          note(
            `${C.label("📋 Pick a session to resume")} (${ours.length} total):`,
          );
          for (let i = 0; i < pickCount; i++) {
            const s = ours[i];
            const current =
              state.activeSession &&
              s.sessionId === state.activeSession.sessionId
                ? ` ${C.ok("← current")}`
                : "";
            const modified = s.modifiedTime
              ? new Date(s.modifiedTime).toLocaleString()
              : "unknown";
            const summary = s.summary
              ? ` — ${s.summary.slice(0, 50)}${s.summary.length > 50 ? "…" : ""}`
              : "";
            const num = String(i + 1).padStart(2);
            note(`   ${C.warn(num)}) ${C.dim(modified)}${summary}${current}`);
          }
          if (ours.length > pickCount) {
            note(
              `   ${C.dim(`… ${ours.length - pickCount} older sessions not shown`)}`,
            );
          }
          blank();

          // Prompt for selection — routes through AgentUI so non-terminal
          // ports can render their own picker.
          const trimmed = await ui.askText({
            question: `Enter number (1-${pickCount}) or session ID:`,
            kind: "resume_session",
          });
          if (!trimmed) {
            note(`${C.dim("Cancelled.")}`);
            blank();
            return true;
          }

          // Check if it's a number
          const num = parseInt(trimmed, 10);
          if (!isNaN(num) && num >= 1 && num <= pickCount) {
            targetId = ours[num - 1].sessionId;
          } else {
            // Treat as session ID (partial match)
            const prefixed = SESSION_ID_PREFIX + trimmed;
            const match =
              ours.find((s) => s.sessionId.startsWith(prefixed)) ??
              ours.find((s) => s.sessionId.startsWith(trimmed));
            if (match) {
              targetId = match.sessionId;
            } else {
              targetId = trimmed; // pass through — SDK will error if invalid
            }
          }
        } else {
          // Allow partial session ID matching (with or without prefix)
          const allSessions = await state.copilotClient.listSessions();
          const ours = allSessions.filter((s) =>
            s.sessionId.startsWith(SESSION_ID_PREFIX),
          );
          // Try matching with prefix prepended, then without
          const prefixed = SESSION_ID_PREFIX + targetId;
          const match =
            ours.find((s) => s.sessionId.startsWith(prefixed)) ??
            ours.find((s) => s.sessionId.startsWith(targetId!));
          if (match) {
            targetId = match.sessionId;
          }
          // If no match, pass through — the SDK will error if invalid
        }
        if (state.activeSession) {
          await state.activeSession.destroy();
        }
        state.activeSession = await state.copilotClient.resumeSession(
          targetId,
          {
            model: state.currentModel,
            ...buildSessionConfig(),
          } as any,
        );
        registerEventHandler(state.activeSession);
        // Local session-learning state cannot be reconstructed from a
        // resumed remote session — clear it so /save-skill doesn't
        // mine stale history from the previously active conversation.
        state.toolCallHistory = [];
        state.mcpServersUsed = new Set();
        state.modulesRegistered = [];
        state.currentUserPrompt = "";
        state.lastGuidance = null;
        note(
          `${C.ok("⏮️  Resumed session:")} ${C.val(targetId.slice(0, 12) + "…")}`,
        );
        note(`   Model: ${C.val(state.currentModel)}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        note(`${C.err("❌ Failed to resume session: " + msg)}`);
      }
      blank();
      return true;
    }

    case "/config": {
      const cpuMs = state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs;
      const wallMs =
        state.wallTimeoutOverride ?? sandbox.config.wallClockTimeoutMs;
      const sendMs = state.sendTimeoutOverride ?? SEND_TIMEOUT_MS;
      const buffers = sandbox.getEffectiveBufferSizes();
      const ovr = C.warn(" (override)");
      // Build config rows for both plain and markdown display
      const mem = sandbox.getEffectiveMemorySizes();
      const ovrTag = " ⚠ override";
      type CfgRow = [label: string, value: string, override: boolean];
      const cfgRows: CfgRow[] = [
        ["Model", state.currentModel, false],
        ["CPU timeout", cpuMs + "ms", state.cpuTimeoutOverride !== null],
        ["Wall timeout", wallMs + "ms", state.wallTimeoutOverride !== null],
        ["Send timeout", sendMs + "ms", state.sendTimeoutOverride !== null],
        ["Heap", mem.heapMb + "MB", state.heapOverride !== null],
        ["Scratch", mem.scratchMb + "MB", state.scratchOverride !== null],
        [
          "Input buffer",
          buffers.inputKb + "KB",
          state.inputBufferOverride !== null,
        ],
        [
          "Output buffer",
          buffers.outputKb + "KB",
          state.outputBufferOverride !== null,
        ],
        [
          "Transcript",
          transcript.active ? `ON → ${transcript.rawPath ?? ""}` : "OFF",
          false,
        ],
        ["Show code", state.showCodeEnabled ? "ON" : "OFF", false],
        ["Show timing", state.showTimingEnabled ? "ON" : "OFF", false],
        ["Debug", state.debugEnabled ? "ON" : "OFF", false],
        ["Verbose", state.verboseOutput ? "ON" : "OFF", false],
        [
          "Reasoning",
          `conversation: ${
            state.reasoningEffort ?? "model default"
          } · audit: ${state.auditReasoningEffort ?? "medium"}`,
          false,
        ],
      ];
      if (sandbox.config.timingLogPath) {
        cfgRows.push(["Timing log", sandbox.config.timingLogPath, false]);
      }
      if (sandbox.config.codeLogPath) {
        cfgRows.push(["Code log", sandbox.config.codeLogPath, false]);
      }
      // Plugin summary
      const enabledPlugins = pluginManager.getEnabledPlugins();
      const allPlugins = pluginManager.listPlugins();
      if (allPlugins.length > 0) {
        const audited = allPlugins.filter((p) => p.audit !== null).length;
        const approved = allPlugins.filter((p) => p.approved).length;
        cfgRows.push([
          "Plugins",
          `${enabledPlugins.length}/${allPlugins.length} enabled, ${audited} audited, ${approved} approved`,
          false,
        ]);
      } else {
        cfgRows.push(["Plugins", "none discovered", false]);
      }

      if (state.markdownEnabled) {
        const mdRows = cfgRows
          .map(([k, v, isOvr]) => `| ${k} | ${v}${isOvr ? ovrTag : ""} |`)
          .join("\n");
        const table = `| Setting | Value |\n|---------|-------|\n${mdRows}`;
        // Use C.label() rather than literal markdown bold — console.log
        // does not pass through the markdown renderer, so `**foo**` would
        // print raw asterisks.
        note(`${C.label("⚙️  Configuration:")}`);
        // The rendered markdown block already includes its own line
        // breaks and table formatting — emit with no indent prefix.
        noteRaw(renderMarkdown(table));
      } else {
        note(`${C.label("⚙️  Configuration:")}`);
        for (const [label, value, isOvr] of cfgRows) {
          const ovrSuffix = isOvr ? ovr : "";
          note(`   ${label.padEnd(15)} ${C.val(value)}${ovrSuffix}`);
        }
        // Show enabled plugin details in plain mode
        for (const p of enabledPlugins) {
          const risk = p.audit?.riskLevel ?? "?";
          note(
            `     ${C.ok("✅")} ${C.tool(p.manifest.name)} v${p.manifest.version} ${C.dim("[" + risk + "]")}`,
          );
        }
      }
      note(
        `   Risk policy:  ${C.val("max " + operatorConfig.maxRiskLevel)} ${C.dim("(via ~/.hyperagent/config.json)")}`,
      );
      blank();
      return true;
    }

    case "/files": {
      // List all files produced during this session
      if (state.producedFiles.length === 0) {
        note(`${C.dim("No files produced yet in this session.")}`);
      } else {
        note(`${C.label("📂 Files produced this session:")}`);
        for (const f of state.producedFiles) {
          note(
            `  ${C.val(`[${f.index}]`)} ${f.absPath} ${C.dim(`(${f.label})`)}`,
          );
        }
        // Preserve the leading blank produced by the original
        // `\n  ${...}` template literal.
        blank();
        note(`${C.dim("Use /open <n> to open a file, e.g. /open 1")}`);
      }
      blank();
      return true;
    }

    case "/open": {
      // Open a produced file by its reference number
      const rawNum = parts[1] ?? "";
      const fileNum = /^\d+$/.test(rawNum) ? parseInt(rawNum, 10) : NaN;
      if (!rawNum || !Number.isFinite(fileNum) || fileNum < 1) {
        note(`${C.err("Usage: /open <n>")} — open a produced file by number.`);
        note(`${C.dim("Run /files to see available files.")}`);
        blank();
        return true;
      }
      const file = state.producedFiles.find((f) => f.index === fileNum);
      if (!file) {
        note(
          `${C.err(`File [${fileNum}] not found.`)} Run /files to see available files.`,
        );
        blank();
        return true;
      }
      // Open file using platform-appropriate command.
      // Use spawnSync with argv arrays to avoid shell injection.
      const { spawnSync, execSync } = await import("child_process");
      try {
        // Detect WSL — convert to Windows path and use cmd.exe /c start
        const isWSL = existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
        if (isWSL) {
          const winPath = execSync(`wslpath -w "${file.absPath}"`, {
            encoding: "utf-8",
          }).trim();
          spawnSync("cmd.exe", ["/c", "start", "", winPath], {
            stdio: "ignore",
          });
        } else if (process.platform === "darwin") {
          spawnSync("open", [file.absPath], { stdio: "ignore" });
        } else {
          spawnSync("xdg-open", [file.absPath], { stdio: "ignore" });
        }
        note(`${C.ok("✅")} Opened [${fileNum}] ${file.label}`);
      } catch (err) {
        note(`${C.err("❌")} Failed to open: ${(err as Error).message}`);
        note(`${C.dim("Path:")} ${file.absPath}`);
      }
      blank();
      return true;
    }

    case "/attach": {
      // Queue file(s) to be attached to the next user message.
      // Subcommands:
      //   /attach              → list the current pending queue
      //   /attach clear        → drop everything currently queued
      //   /attach <path> [ …]  → resolve each path and push onto the queue
      //
      // Any resolver failure aborts the whole call — partial state is
      // confusing ("did /attach a b c add a, or a+b, or a+b+c?") and a
      // failed call leaves the existing queue intact so the user can
      // retry without losing prior entries.
      const attachArgs = parts.slice(1);

      // ── No args: show current queue ──────────────────────────────
      if (attachArgs.length === 0) {
        if (state.pendingAttachments.length === 0) {
          ui.emitNotification({
            level: "info",
            kind: "pending_attachments",
            message: "No pending attachments.",
          });
        } else {
          const names = state.pendingAttachments
            .map((a) => ("displayName" in a && a.displayName) || a.type)
            .join(", ");
          ui.emitNotification({
            level: "info",
            kind: "pending_attachments",
            message: `Pending attachments (${state.pendingAttachments.length}): ${names}`,
          });
        }
        return true;
      }

      // ── /attach clear: drop the queue ────────────────────────────
      if (attachArgs.length === 1 && attachArgs[0] === "clear") {
        const cleared = state.pendingAttachments.length;
        state.pendingAttachments = [];
        ui.emitNotification({
          level: "success",
          kind: "pending_attachments",
          message:
            cleared === 0
              ? "No pending attachments to clear."
              : `Cleared ${cleared} pending attachment${cleared === 1 ? "" : "s"}.`,
        });
        return true;
      }

      // ── /attach <path> [<path> …]: resolve and enqueue ───────────
      const newAttachments = [];
      for (const arg of attachArgs) {
        try {
          newAttachments.push(resolveFileAttachment(arg, "/attach"));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ui.emitNotification({
            level: "error",
            kind: "pending_attachments",
            message: msg,
          });
          return true;
        }
      }
      state.pendingAttachments.push(...newAttachments);
      const names = newAttachments
        .map((a) => ("displayName" in a && a.displayName) || a.type)
        .join(", ");
      ui.emitNotification({
        level: "success",
        kind: "pending_attachments",
        message: `Queued attachment${newAttachments.length === 1 ? "" : "s"}: ${names}`,
      });
      return true;
    }

    case "/history": {
      // Display recent conversation messages from the active session.
      // Uses the SDK's session.getMessages() to retrieve the full
      // event log, then filters for user & assistant messages.
      if (!state.activeSession) {
        note(`${C.err("❌ No active session.")}`);
        blank();
        return true;
      }
      const histCount = parseInt(parts[1] ?? "10", 10);
      const showCount =
        Number.isFinite(histCount) && histCount > 0 ? histCount : 10;
      try {
        const events = await state.activeSession.getMessages();
        // Filter to user/assistant messages — skip tool calls, deltas, etc.
        const messages = events
          .filter(
            (e: { type: string }) =>
              e.type === "user.message" || e.type === "assistant.message",
          )
          .slice(-showCount);

        if (messages.length === 0) {
          note(`${C.dim("No messages in this session yet.")}`);
        } else {
          const MAX_PREVIEW_LEN = 200;
          note(`${C.label(`📜 Last ${messages.length} message(s):`)}`);
          for (const msg of messages) {
            const isUser = msg.type === "user.message";
            const role = isUser ? "You" : "Agent";
            const content: string =
              (msg as { data?: { content?: string } }).data?.content ?? "";
            const preview =
              content.length > MAX_PREVIEW_LEN
                ? content.slice(0, MAX_PREVIEW_LEN) + "…"
                : content;
            // Show first line only to keep it compact
            const firstLine = preview.split("\n")[0];
            note(
              `   ${C.label(role + ":")} ${isUser ? C.val(firstLine) : firstLine}`,
            );
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        note(`${C.err("❌ Failed to retrieve history: " + msg)}`);
      }
      blank();
      return true;
    }

    // ── Plugin Commands ──────────────────────────────────────
    //
    // All plugin operations live under /plugin <sub>.
    // /plugins is an alias for /plugin.

    case "/plugins":
    case "/plugin": {
      const subCmd = parts[1]?.toLowerCase();
      // Plugin name sits at parts[2], args at parts[3]+.
      const pluginName = parts[2];

      switch (subCmd) {
        // ── /plugin list ─────────────────────────────────
        case "list": {
          pluginManager.discover();
          const allP = pluginManager.listPlugins();
          if (allP.length === 0) {
            noteIcon("🔌", "No plugins discovered.");
            note(
              "   Create a plugins/ directory with subdirectories containing plugin.json",
            );
          } else {
            // Count states for the legend
            const hasEnabled = allP.some((p) => p.state === "enabled");
            const hasDisabled = allP.some((p) => p.state === "disabled");
            const hasApproved = allP.some((p) => p.approved);
            const enabledCount = allP.filter(
              (p) => p.state === "enabled",
            ).length;

            note(
              `${C.label("🔌 Plugins")} (${allP.length}` +
                `${enabledCount > 0 ? `, ${C.ok(enabledCount + " active")}` : ""}):`,
            );

            for (const p of allP) {
              // Simple traffic-light: green = on, grey = off, pause = paused
              const icon =
                p.state === "enabled"
                  ? "🟢"
                  : p.state === "disabled"
                    ? "⏸️ "
                    : "⚪";
              const risk = p.audit?.riskLevel
                ? ` ${C.dim("[" + p.audit.riskLevel + "]")}`
                : "";
              const approved = p.approved ? " 🔒" : "";
              note(
                `   ${icon} ${C.tool(p.manifest.name)} v${p.manifest.version}` +
                  `${risk}${approved}`,
              );
              note(`      ${C.dim(p.manifest.description)}`);
              // Show companion relationships so the LLM (and user)
              // can see which plugins will be auto-enabled together.
              if (p.manifest.companions && p.manifest.companions.length > 0) {
                note(
                  `      ${C.dim("🔗 companions: " + p.manifest.companions.join(", "))}`,
                );
              }
            }

            // Legend — only show symbols that actually appear
            blank();
            const legend: string[] = ["⚪ = available"];
            if (hasEnabled) legend.push("🟢 = enabled");
            if (hasDisabled) legend.push("⏸️  = disabled");
            if (hasApproved) legend.push("🔒 = approved (skip audit)");
            note(`   ${C.dim(legend.join("    "))}`);
            if (!hasEnabled) {
              note("   Use /plugin info <name> for config options.");
              note("   Use /plugin enable <name> to activate a plugin.");
            }
          }
          blank();
          break;
        }

        // ── /plugin info <name> ─────────────────────────
        // Shows manifest details and config schema so users
        // know what k=v options are available before enabling.
        case "info": {
          if (!pluginName) {
            note("Usage: /plugin info <name>");
            note("   Use /plugin list to see available plugins.");
            blank();
            break;
          }

          pluginManager.discover();
          const infoPlugin = pluginManager.getPlugin(pluginName);
          if (!infoPlugin) {
            note(
              `${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
            );
            note("   Use /plugin list to see available plugins.");
            blank();
            break;
          }

          // Extract schema and hints from TypeScript source (falls back to manifest)
          await pluginManager.extractSchemaAndHints(pluginName);

          const m = infoPlugin.manifest;
          const stateIcon =
            infoPlugin.state === "enabled"
              ? "🟢"
              : infoPlugin.state === "disabled"
                ? "⏸️ "
                : "⚪";

          // ── Header ───────────────────────────────────────
          noteIcon(
            "🔌",
            `${C.tool(m.name)} v${m.version}  ${stateIcon}${infoPlugin.approved ? " 🔒" : ""}`,
          );
          note(`   ${C.dim(m.description)}`);
          blank();

          // ── Host modules ────────────────────────────────
          note(
            `   ${C.label("Host modules:")} ${m.hostModules.map((h) => C.val(`host:${h}`)).join(", ")}`,
          );
          note(
            `   ${C.label("State:")}        ${C.val(infoPlugin.state)}${infoPlugin.approved ? C.ok(" (approved)") : ""}`,
          );

          // ── Audit summary (if available) ─────────────────
          if (infoPlugin.audit) {
            const a = infoPlugin.audit;
            note(
              `   ${C.label("Risk:")}         ${C.warn(a.riskLevel)}  \u2014  ${a.recommendation.verdict}`,
            );
            note(`   ${C.label("Summary:")}      ${a.summary}`);
          }
          blank();

          // ── Config schema ───────────────────────────────
          // Use extracted schema or fall back to manifest
          const schema = infoPlugin.schema ?? m.configSchema ?? {};
          const schemaEntries = Object.entries(schema);
          if (schemaEntries.length === 0) {
            note("   No configurable options.");
          } else {
            // Determine which keys are prompted interactively
            const promptKeysArr = infoPlugin.promptKeys ?? m.promptKeys;
            const promptSet = promptKeysArr ? new Set(promptKeysArr) : null; // null = all prompted

            note("   Config options:");
            blank();
            for (const [key, entry] of schemaEntries) {
              // Type tag with constraints
              const constraints: string[] = [];
              if (entry.minimum !== undefined)
                constraints.push(`min: ${entry.minimum}`);
              if (entry.maximum !== undefined)
                constraints.push(`max: ${entry.maximum}`);
              if (entry.maxLength !== undefined)
                constraints.push(`maxLen: ${entry.maxLength}`);
              const constraintStr =
                constraints.length > 0 ? ` (${constraints.join(", ")})` : "";

              // Default value display
              const hasDefault = entry.default !== undefined;
              const defaultStr = hasDefault
                ? Array.isArray(entry.default)
                  ? `[${(entry.default as string[]).join(", ")}]`
                  : String(entry.default)
                : "none \u2014 required";

              // Prompted-interactively indicator:
              // When promptKeys is defined, clearly distinguish
              // prompted fields from advanced (silently-defaulted) ones.
              let promptTag: string;
              if (promptSet === null) {
                // No promptKeys → all fields are prompted
                promptTag = hasDefault ? "" : " \u2190 prompted";
              } else if (promptSet.has(key)) {
                // Explicitly in promptKeys
                promptTag = hasDefault
                  ? " \u2190 prompted"
                  : " \u2190 prompted (required)";
              } else {
                // Not in promptKeys
                promptTag = hasDefault
                  ? " \u2190 advanced (default applied silently)"
                  : " \u2190 prompted (required, no default)";
              }

              note(`     ${key}  (${entry.type}${constraintStr})`);
              note(`       ${entry.description}`);
              note(`       Default: ${defaultStr}${promptTag}`);
              blank();
            }
          }

          // ── Hints (concise guidance for LLM) ────────────
          const hints = infoPlugin.hints ?? m.systemMessage;
          if (hints) {
            note("   Hints for LLM:");
            blank();
            // Truncate to first 500 chars for info display
            const truncated =
              hints.length > 500 ? hints.slice(0, 500) + "..." : hints;
            for (const line of truncated.split("\n").slice(0, 10)) {
              note(`     ${C.dim(line)}`);
            }
            if (hints.length > 500 || hints.split("\n").length > 10) {
              note(
                `     ${C.dim("(truncated - see systemMessage for full text)")}`,
              );
            }
            blank();
          }

          // ── Example enable command ─────────────────────
          // Build an example showing required fields and
          // one optional override to hint at the syntax.
          const requiredKeys = schemaEntries
            .filter(([, e]) => e.default === undefined)
            .map(
              ([k, e]) =>
                `${k}=${e.type === "array" ? "val1,val2" : `<${e.type}>`}`,
            );
          const optionalKeys = schemaEntries
            .filter(([, e]) => e.default !== undefined)
            .slice(0, 1) // just one example
            .map(([k, e]) => {
              const val = Array.isArray(e.default)
                ? (e.default as string[]).join(",")
                : String(e.default);
              return `${k}=${val}`;
            });
          const exampleArgs = [...requiredKeys, ...optionalKeys].join(" ");
          if (exampleArgs) {
            note(`   Example: /plugin enable ${m.name} ${exampleArgs}`);
          } else {
            note(`   Example: /plugin enable ${m.name}`);
          }
          blank();
          break;
        }

        // ── /plugin enable <name> [key=value ...] ───────
        case "enable": {
          if (!pluginName) {
            note("Usage: /plugin enable <name> [key=value ...]");
            note("   Use /plugin list to see available plugins.");
            note("   Use /plugin info <name> to see config options.");
            note("   Inline config overrides schema defaults, e.g.:");
            note("   /plugin enable fs-read baseDir=/tmp maxFileSizeKb=2048");
            blank();
            break;
          }

          pluginManager.discover();
          const targetPlugin = pluginManager.getPlugin(pluginName);
          if (!targetPlugin) {
            note(
              `${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
            );
            note("   Use /plugin list to see available plugins.");
            blank();
            break;
          }

          // Parse inline config args (everything after the plugin name)
          const inlineConfigArgs = parts.slice(3);
          const hasInlineConfig = inlineConfigArgs.length > 0;

          // ── Reconfigure-in-place when already enabled ─────
          // If the user passes inline config overrides to an
          // already-enabled plugin, apply them and rebuild the
          // sandbox rather than silently ignoring the change.
          if (targetPlugin.state === "enabled") {
            if (!hasInlineConfig) {
              noteIcon("ℹ️ ", `"${pluginName}" is already enabled.`);
              blank();
              break;
            }

            // Apply the inline overrides to the running config
            const { parseInlineConfig } =
              await import("../plugin-system/manager.js");
            const inlineKV = parseInlineConfig(inlineConfigArgs);
            const applied = pluginManager.applyInlineConfig(
              pluginName,
              inlineKV,
            );

            if (applied.length === 0) {
              noteIcon(
                "⚠️ ",
                `No recognised config keys in: ${inlineConfigArgs.join(" ")}`,
              );
              note(
                `   Use /plugin info ${pluginName} to see available settings.`,
              );
              blank();
              break;
            }

            // Mark sandbox dirty so it rebuilds with the new config
            pluginManager.markSandboxDirty();

            noteIcon("🔄", `"${pluginName}" reconfigured:`);
            if (state.markdownEnabled) {
              const rows = applied.map((key) => {
                const val = targetPlugin.config[key];
                const display = Array.isArray(val)
                  ? `[${(val as string[]).join(", ")}]`
                  : String(val);
                return `| ${key} | ${display} |`;
              });
              const table = `| Key | Value |\n|-----|-------|\n${rows.join("\n")}`;
              noteRaw(renderMarkdown(table));
            } else {
              for (const key of applied) {
                const val = targetPlugin.config[key];
                const display = Array.isArray(val)
                  ? `[${(val as string[]).join(", ")}]`
                  : String(val);
                note(`   ${key} = ${display}`);
              }
            }
            note("   Changes take effect on the next message.");
            blank();
            break;
          }

          // ── Fast-path: approved plugins skip audit ───
          // Even approved plugins are checked against the operator's
          // current risk threshold — the config file may have been
          // tightened since the approval was granted.
          if (targetPlugin.approved) {
            const storedRisk = targetPlugin.audit?.riskLevel;
            if (
              storedRisk &&
              exceedsRiskThreshold(storedRisk, operatorConfig.maxRiskLevel)
            ) {
              noteIcon(
                "🚫",
                `"${pluginName}" is approved but its risk level (${storedRisk}) exceeds` +
                  ` the operator threshold (max: ${operatorConfig.maxRiskLevel}).`,
              );
              note(
                `   Update maxRiskLevel in ~/.hyperagent/config.json to allow ${storedRisk} or above.`,
              );
              blank();
              break;
            }
            noteIcon("🔒", `"${pluginName}" is approved — skipping audit.`);

            // Extract schema and hints from TypeScript source (falls back to manifest)
            await pluginManager.extractSchemaAndHints(pluginName);
            // Refresh plugin reference after extraction
            const refreshedPlugin = pluginManager.getPlugin(pluginName)!;

            if (hasInlineConfig) {
              const { parseInlineConfig } =
                await import("../plugin-system/manager.js");
              const inlineKV = parseInlineConfig(inlineConfigArgs);
              const applied = pluginManager.applyInlineConfig(
                pluginName,
                inlineKV,
              );
              if (applied.length > 0) {
                note(`${C.label("⚙️  Config overrides:")}`);
                const updatedPlugin = pluginManager.getPlugin(pluginName);
                for (const key of applied) {
                  const val = updatedPlugin?.config[key];
                  const displayVal = Array.isArray(val)
                    ? val.join(", ")
                    : String(val);
                  note(`   ${C.dim(key + ":")} ${displayVal}`);
                }
              }
              const coveredKeys = new Set(Object.keys(inlineKV));
              // Use extracted schema (now populated) or fall back to manifest
              const schema =
                refreshedPlugin.schema ??
                refreshedPlugin.manifest.configSchema ??
                {};
              const hasUncovered = Object.keys(schema).some(
                (k) => !coveredKeys.has(k),
              );
              if (hasUncovered) {
                const uncoveredFields = Object.keys(schema).filter(
                  (k) => !coveredKeys.has(k),
                );
                blank();
                noteIcon(
                  "⚙️ ",
                  `Configure remaining fields for "${pluginName}":`,
                );
                note(`   Fields: ${uncoveredFields.join(", ")}`);
                await pluginManager.promptConfig(
                  ui,
                  pluginName,
                  coveredKeys,
                  state.autoApprove,
                );
              }
            } else {
              // Use extracted schema (now populated) or fall back to manifest
              const schema =
                refreshedPlugin.schema ??
                refreshedPlugin.manifest.configSchema ??
                {};
              if (Object.keys(schema).length > 0) {
                blank();
                noteIcon("⚙️ ", `Configure "${pluginName}":`);
                await pluginManager.promptConfig(
                  ui,
                  pluginName,
                  undefined,
                  state.autoApprove,
                );
              }
            }

            // ── Final config summary and approval ─────
            const configSummary = pluginManager.formatConfigSummary(pluginName);
            if (configSummary.length > 0) {
              blank();
              noteIcon("📋", `Final configuration for "${pluginName}":`);
              if (state.markdownEnabled) {
                const table = formatConfigTable(configSummary);
                noteRaw(renderMarkdown(table));
              } else {
                for (const line of configSummary) {
                  note(`  ${line}`);
                }
              }

              await ui.drainPasteBuffer();
              const finalApprove: "yes" | "no" = state.autoApprove
                ? "yes"
                : await ui.askApproval({
                    question: "Enable with this configuration?",
                    kind: "plugin_audit",
                    defaultChoice: "no",
                  });
              if (finalApprove !== "yes") {
                note(`${C.dim("Plugin not enabled.")}`);
                blank();
                break;
              }
            }

            // Load source before enabling — syncPluginsToSandbox needs
            // plugin.source for verifySourceHash(). Without this, the
            // hash check fails and the plugin is silently disabled.
            if (!pluginManager.loadSource(pluginName)) {
              note(
                `${C.err("❌ Failed to load source for")} "${pluginName}". Plugin will not be enabled.`,
              );
              blank();
              break;
            }

            pluginManager.enable(pluginName);
            noteIcon(
              "✅",
              `Plugin "${pluginName}" enabled (approved fast-path).`,
            );
            note("   Changes take effect on the next message.");

            // Check for companion plugins
            const fastPathCompanions = pluginManager.getCompanions(pluginName);
            if (fastPathCompanions.length > 0) {
              noteIcon(
                "🔗",
                `Companion${fastPathCompanions.length > 1 ? "s" : ""} needed: ${fastPathCompanions.join(", ")}`,
              );
              const fpParentConfig =
                pluginManager.getPlugin(pluginName)?.config ?? {};
              for (const comp of fastPathCompanions) {
                const sharedArgs: string[] = [];
                // Pass all parent config through unconditionally.
                // Companions ignore keys they don't understand.
                // This avoids relying on schema extraction timing.
                for (const [key, val] of Object.entries(fpParentConfig)) {
                  if (val !== undefined) {
                    // If baseDir is empty (auto-temp), create a shared temp
                    // dir so both plugins use the same directory.
                    if (
                      key === "baseDir" &&
                      (val === "" || val === undefined)
                    ) {
                      const sharedDir = join(
                        tmpdir(),
                        `hyperlight-fs-${randomUUID().slice(0, 16)}`,
                      );
                      mkdirSync(sharedDir, { recursive: true });
                      sharedArgs.push(`baseDir=${sharedDir}`);
                      // Also update parent to use the same shared dir
                      fpParentConfig.baseDir = sharedDir;
                      const parentPlugin = pluginManager.getPlugin(pluginName);
                      if (parentPlugin) parentPlugin.config.baseDir = sharedDir;
                    } else {
                      sharedArgs.push(`${key}=${val}`);
                    }
                  }
                }
                const inlineConfig =
                  sharedArgs.length > 0 ? ` ${sharedArgs.join(" ")}` : "";
                blank();
                noteIcon("🔗", `Auto-enabling companion "${comp}"...`);
                if (sharedArgs.length > 0) {
                  note(`   Inheriting config: ${sharedArgs.join(", ")}`);
                }
                await handleSlashCommand(
                  `/plugin enable ${comp}${inlineConfig}`,
                  deps,
                );
              }
            }

            blank();
            break;
          }

          // ── Step 1: Load source and audit ────────────
          const source = pluginManager.loadSource(pluginName);
          if (!source) {
            note(`${C.err("❌ Could not load source for")} "${pluginName}".`);
            blank();
            break;
          }

          // Extract schema and hints from TypeScript source (falls back to manifest)
          await pluginManager.extractSchemaAndHints(pluginName);

          let auditResult = pluginManager.getCachedAudit(source);
          if (auditResult) {
            note("   (using cached audit result)");
          } else if (state.copilotClient) {
            // Retry loop — gives the operator a chance to re-run the
            // LLM audit if the first attempt fails (network blip,
            // model timeout, etc.), rather than silently falling back
            // to a low-quality static-only result.
            let attemptAudit = true;
            while (attemptAudit) {
              attemptAudit = false; // one shot unless the user retries
              const { callback: auditProgress, getTracePath } =
                makeAuditProgressCallback(ui);
              ui.setActivity({
                kind: "custom",
                label: `Auditing "${pluginName}"...`,
              });
              const { controller: auditAbort, cleanup: auditAbortCleanup } =
                createAuditAbortHandler(ui);
              try {
                auditResult = await deepAudit(
                  state.copilotClient,
                  source,
                  targetPlugin.manifest,
                  state.currentModel,
                  auditProgress,
                  state.debugEnabled,
                  auditAbort.signal,
                  state.auditReasoningEffort ?? undefined,
                );
                auditAbortCleanup();
              } catch (err) {
                auditAbortCleanup();
                ui.setActivity(null);
                noteIcon("⚠️ ", `LLM audit failed: ${(err as Error).message}`);
                if (getTracePath()) {
                  noteIcon("📝", `Trace log: ${getTracePath()}`);
                }

                // Ask the operator what to do — don't silently produce garbage
                await ui.drainPasteBuffer();
                // Order matters: empty/default picks "Retry" (matches the
                // legacy [R]etry default); auto-approve picks "Static-only"
                // so unattended runs don't get stuck waiting on an
                // interactive operator answer.
                const choice: string = state.autoApprove
                  ? "Static-only"
                  : (
                      await ui.askChoice({
                        question: "What would you like to do?",
                        choices: ["Retry", "Static-only", "Abort"],
                        allowFreeform: false,
                        kind: "plugin_audit",
                      })
                    ).answer;
                if (choice === "Retry") {
                  noteIcon("🔄", "Retrying audit...");
                  attemptAudit = true;
                  continue;
                } else if (choice === "Abort") {
                  noteIcon("⏹️ ", "Aborted — plugin not enabled.");
                  blank();
                  auditResult = null;
                  break;
                }
                // Fall through: "Static-only" → static-only
                note("   Proceeding with static scan only.");
                const staticFindings = pluginManager.runStaticScan(pluginName);
                const hasDanger = staticFindings.some(
                  (f) => f.severity === "danger",
                );
                auditResult = {
                  contentHash: contentHash(source),
                  auditedAt: new Date().toISOString(),
                  findings: staticFindings,
                  riskLevel: hasDanger ? ("HIGH" as const) : ("LOW" as const),
                  summary: "Static scan only — LLM audit unavailable",
                  descriptionAccurate: false,
                  capabilities: [],
                  riskReasons: [
                    "LLM audit unavailable — risk assessed from static scan only",
                  ],
                  recommendation: {
                    verdict: hasDanger
                      ? ("reject" as const)
                      : ("approve-with-conditions" as const),
                    reason:
                      "LLM audit failed — review static scan findings manually",
                  },
                };
              } finally {
                ui.setActivity(null);
              }
            }
            // User chose abort — bail out of the enable flow entirely
            if (!auditResult) break;
          } else {
            const staticFindings = pluginManager.runStaticScan(pluginName);
            const hasDanger = staticFindings.some(
              (f) => f.severity === "danger",
            );
            auditResult = {
              contentHash: contentHash(source),
              auditedAt: new Date().toISOString(),
              findings: staticFindings,
              riskLevel: hasDanger ? ("HIGH" as const) : ("LOW" as const),
              summary: "Static scan only — no client available",
              descriptionAccurate: false,
              capabilities: [],
              riskReasons: [
                "No audit client available — risk assessed from static scan only",
              ],
              recommendation: {
                verdict: hasDanger
                  ? ("reject" as const)
                  : ("approve-with-conditions" as const),
                reason: "No LLM client — review static scan findings manually",
              },
            };
          }

          pluginManager.setAuditResult(pluginName, auditResult);
          noteRaw(formatAuditResult(auditResult, pluginName));

          // ── Step 2: User approval after audit ──────────
          // The user has seen the audit report — now ask them
          // explicitly whether they want to enable this plugin.
          const verdict = auditResult.recommendation?.verdict ?? "unknown";
          const approvalQuestion =
            verdict === "reject"
              ? `${C.warn("⚠️  Auditor recommends REJECTION.")} Enable anyway?`
              : verdict === "approve-with-conditions"
                ? "Auditor recommends APPROVE WITH CONDITIONS. Enable?"
                : "Enable plugin based on audit?";
          await ui.drainPasteBuffer();
          const approveAnswer: "yes" | "no" = state.autoApprove
            ? "yes"
            : await ui.askApproval({
                question: approvalQuestion,
                kind: "plugin_audit",
                defaultChoice: "no",
              });
          if (approveAnswer !== "yes") {
            note(`${C.dim("Plugin not enabled.")}`);
            blank();
            break;
          }

          // ── Step 3: Enforce operator risk threshold ─────
          if (
            exceedsRiskThreshold(
              auditResult.riskLevel,
              operatorConfig.maxRiskLevel,
            )
          ) {
            noteIcon(
              "🚫",
              `Plugin "${pluginName}" rated ${auditResult.riskLevel} — exceeds` +
                ` operator threshold (max: ${operatorConfig.maxRiskLevel}).`,
            );
            note(`   This plugin cannot be enabled under the current policy.`);
            note(
              `   To allow ${auditResult.riskLevel}-risk plugins, update maxRiskLevel` +
                ` in ~/.hyperagent/config.json`,
            );
            blank();
            break;
          }

          // ── Step 4: Configure ────────────────────────
          if (hasInlineConfig) {
            const { parseInlineConfig } =
              await import("../plugin-system/manager.js");
            const inlineKV = parseInlineConfig(inlineConfigArgs);
            const applied = pluginManager.applyInlineConfig(
              pluginName,
              inlineKV,
            );
            if (applied.length > 0) {
              note(`${C.label("⚙️  Config overrides:")}`);
              const updatedPlugin = pluginManager.getPlugin(pluginName);
              for (const key of applied) {
                const val = updatedPlugin?.config[key];
                const displayVal = Array.isArray(val)
                  ? val.join(", ")
                  : String(val);
                note(`   ${C.dim(key + ":")} ${displayVal}`);
              }
            }
            const coveredKeys = new Set(Object.keys(inlineKV));
            // Use extracted schema or fall back to manifest
            const schema =
              targetPlugin.schema ?? targetPlugin.manifest.configSchema ?? {};
            const hasUncovered = Object.keys(schema).some(
              (k) => !coveredKeys.has(k),
            );
            if (hasUncovered) {
              const uncoveredFields = Object.keys(schema).filter(
                (k) => !coveredKeys.has(k),
              );
              blank();
              noteIcon(
                "⚙️ ",
                `Configure remaining fields for "${pluginName}":`,
              );
              note(`   Fields: ${uncoveredFields.join(", ")}`);
              await pluginManager.promptConfig(
                ui,
                pluginName,
                coveredKeys,
                state.autoApprove,
              );
            }
          } else {
            // Use extracted schema or fall back to manifest
            const schema =
              targetPlugin.schema ?? targetPlugin.manifest.configSchema ?? {};
            if (Object.keys(schema).length > 0) {
              blank();
              noteIcon("⚙️ ", `Configure "${pluginName}":`);
              await pluginManager.promptConfig(
                ui,
                pluginName,
                undefined,
                state.autoApprove,
              );
            }
          }

          // ── Step 5: Final config summary and approval ──
          const configSummary = pluginManager.formatConfigSummary(pluginName);
          if (configSummary.length > 0) {
            blank();
            noteIcon("📋", `Final configuration for "${pluginName}":`);
            if (state.markdownEnabled) {
              const table = formatConfigTable(configSummary);
              noteRaw(renderMarkdown(table));
            } else {
              for (const line of configSummary) {
                note(`  ${line}`);
              }
            }

            await ui.drainPasteBuffer();
            const finalApprove: "yes" | "no" = state.autoApprove
              ? "yes"
              : await ui.askApproval({
                  question: "Enable with this configuration?",
                  kind: "plugin_audit",
                  defaultChoice: "no",
                });
            if (finalApprove !== "yes") {
              note(`${C.dim("Plugin not enabled.")}`);
              blank();
              break;
            }
          }

          // ── Step 6: Enable ───────────────────────────
          pluginManager.enable(pluginName);
          noteIcon("✅", `Plugin "${pluginName}" enabled.`);
          note("   Changes take effect on the next message.");

          // Check for companion plugins
          const companions = pluginManager.getCompanions(pluginName);
          if (companions.length > 0) {
            blank();
            noteIcon(
              "🔗",
              `Companion plugin${companions.length > 1 ? "s" : ""}: ${companions.join(", ")}`,
            );
            note(
              `   ${C.dim(`"${pluginName}" requires ${companions.length > 1 ? "these plugins" : "this plugin"} — enabling automatically.`)}`,
            );
            // Build inline config from parent's config — share common
            // keys (e.g. baseDir) so companions use the same directory.
            const parentConfig =
              pluginManager.getPlugin(pluginName)?.config ?? {};
            for (const comp of companions) {
              const sharedArgs: string[] = [];
              // Pass all parent config through unconditionally.
              // Companions ignore keys they don't understand.
              // This avoids relying on schema extraction timing.
              for (const [key, val] of Object.entries(parentConfig)) {
                if (val !== undefined) {
                  // If baseDir is empty (auto-temp), create a shared temp
                  // dir so both plugins use the same directory.
                  if (key === "baseDir" && (val === "" || val === undefined)) {
                    const sharedDir = join(
                      tmpdir(),
                      `hyperlight-fs-${randomUUID().slice(0, 16)}`,
                    );
                    mkdirSync(sharedDir, { recursive: true });
                    sharedArgs.push(`baseDir=${sharedDir}`);
                    // Also update parent to use the same shared dir
                    parentConfig.baseDir = sharedDir;
                    const parentPlugin = pluginManager.getPlugin(pluginName);
                    if (parentPlugin) parentPlugin.config.baseDir = sharedDir;
                  } else {
                    sharedArgs.push(`${key}=${val}`);
                  }
                }
              }
              const inlineConfig =
                sharedArgs.length > 0 ? ` ${sharedArgs.join(" ")}` : "";
              blank();
              noteIcon("🔗", `Auto-enabling companion "${comp}"...`);
              if (sharedArgs.length > 0) {
                note(`   Inheriting config: ${sharedArgs.join(", ")}`);
              }
              await handleSlashCommand(
                `/plugin enable ${comp}${inlineConfig}`,
                deps,
              );
            }
          }

          blank();
          break;
        }

        // ── /plugin disable <name> ──────────────────────
        case "disable": {
          if (!pluginName) {
            note("Usage: /plugin disable <name>");
            blank();
            break;
          }
          const success = pluginManager.disable(pluginName);
          if (success) {
            noteIcon("⏸️ ", `Plugin "${pluginName}" disabled.`);
            note("   Changes take effect on the next message.");
          } else {
            const p = pluginManager.getPlugin(pluginName);
            if (!p) {
              note(
                `${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
              );
            } else {
              noteIcon(
                "ℹ️ ",
                `"${pluginName}" is not enabled (state: ${p.state}).`,
              );
            }
          }
          blank();
          break;
        }

        // ── /plugin approve <name> ──────────────────────
        case "approve": {
          if (!pluginName) {
            note("Usage: /plugin approve <name>");
            note(
              "   Approved plugins skip audit on /plugin enable (fast-path).",
            );
            note("   Approval is invalidated if the plugin source changes.");
            blank();
            break;
          }

          pluginManager.discover();
          const approveTarget = pluginManager.getPlugin(pluginName);
          if (!approveTarget) {
            note(
              `${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
            );
            blank();
            break;
          }

          if (approveTarget.approved) {
            noteIcon("ℹ️ ", `"${pluginName}" is already approved.`);
            blank();
            break;
          }

          if (!approveTarget.audit) {
            note(
              `${C.err("❌")} "${pluginName}" ${C.err("must be audited before approval.")}`,
            );
            note("   Run /plugin audit or /plugin enable first.");
            blank();
            break;
          }

          // Check risk threshold before granting approval
          if (
            exceedsRiskThreshold(
              approveTarget.audit.riskLevel,
              operatorConfig.maxRiskLevel,
            )
          ) {
            noteIcon(
              "🚫",
              `"${pluginName}" rated ${approveTarget.audit.riskLevel} — exceeds` +
                ` operator threshold (max: ${operatorConfig.maxRiskLevel}).`,
            );
            note(
              `   Cannot approve plugins above ${operatorConfig.maxRiskLevel} risk.`,
            );
            note(
              `   Update maxRiskLevel in ~/.hyperagent/config.json to change.`,
            );
            blank();
            break;
          }

          const approved = pluginManager.approve(pluginName);
          if (approved) {
            noteIcon("🔒", `Plugin "${pluginName}" approved.`);
            note(
              "   Approval persists across sessions until the source changes or you /plugin unapprove.",
            );
          } else {
            note(`${C.err("❌ Could not approve")} "${pluginName}".`);
          }
          blank();
          break;
        }

        // ── /plugin unapprove <name> ────────────────────
        case "unapprove": {
          if (!pluginName) {
            note("Usage: /plugin unapprove <name>");
            blank();
            break;
          }

          const unapproved = pluginManager.unapprove(pluginName);
          if (unapproved) {
            noteIcon("🔓", `Plugin "${pluginName}" approval removed.`);
            note("   Next /plugin enable will require a full audit.");
          } else {
            const p = pluginManager.getPlugin(pluginName);
            if (!p) {
              note(
                `${C.err("❌ Plugin")} "${pluginName}" ${C.err("not found.")}`,
              );
            } else {
              noteIcon("ℹ️ ", `"${pluginName}" is not currently approved.`);
            }
          }
          blank();
          break;
        }

        // ── /plugin audit <name> [--verbose|-v] ────────
        case "audit": {
          // Parse flags — --verbose or -v anywhere in parts[2:]
          const auditArgs = parts.slice(2);
          const verboseAudit =
            auditArgs.includes("--verbose") || auditArgs.includes("-v");
          // Plugin name is the first non-flag arg
          const auditPluginName = auditArgs.find((a) => !a.startsWith("-"));
          if (!auditPluginName) {
            note("Usage: /plugin audit <name> [--verbose]");
            blank();
            break;
          }
          const auditTarget = pluginManager.getPlugin(auditPluginName);
          if (!auditTarget) {
            note(
              `${C.err("❌ Plugin")} "${auditPluginName}" ${C.err("not found.")}`,
            );
            blank();
            break;
          }
          const auditSource = pluginManager.loadSource(auditPluginName);
          if (!auditSource) {
            note(
              `${C.err("❌ Could not load source for")} "${auditPluginName}".`,
            );
            blank();
            break;
          }
          noteIcon("🔍", `Auditing "${auditPluginName}"...`);
          if (state.copilotClient) {
            // Retry loop — operator gets a chance to re-run the audit
            // on transient failures instead of losing all progress.
            let attemptAudit = true;
            while (attemptAudit) {
              attemptAudit = false;
              const { callback: auditProgress, getTracePath } =
                makeAuditProgressCallback(ui);
              ui.setActivity({
                kind: "custom",
                label: `Auditing "${auditPluginName}"...`,
              });
              const { controller: auditAbort, cleanup: auditAbortCleanup } =
                createAuditAbortHandler(ui);
              try {
                const result = await deepAudit(
                  state.copilotClient,
                  auditSource,
                  auditTarget.manifest,
                  state.currentModel,
                  auditProgress,
                  state.debugEnabled,
                  auditAbort.signal,
                  state.auditReasoningEffort ?? undefined,
                );
                auditAbortCleanup();
                ui.setActivity(null);
                if (getTracePath()) {
                  noteIcon("📝", `Trace log: ${getTracePath()}`);
                }
                pluginManager.setAuditResult(auditPluginName, result);
                noteRaw(
                  formatAuditResult(result, auditPluginName, {
                    verbose: verboseAudit,
                  }),
                );
              } catch (err) {
                auditAbortCleanup();
                ui.setActivity(null);
                const errObj = err as Error;
                note(`${C.err("❌ Audit failed: " + errObj.message)}`);
                // Always log the full stack via the UI so it's captured
                // in the transcript and timed output for tracing.
                // (Originally console.error — promoted to plain stdout via
                // the UI for the same reasons documented in Phase 3d.)
                noteRaw("[audit-trace] Full error:");
                noteRaw(String(errObj.stack ?? errObj));

                await ui.drainPasteBuffer();
                // Default "yes" so an empty answer retries — matches the
                // legacy [Y]es / [n]o hint where uppercase signalled the
                // Enter-pick. Auto-approve picks "no" to avoid an audit
                // retry loop in unattended runs.
                const answer: "yes" | "no" = state.autoApprove
                  ? "no"
                  : await ui.askApproval({
                      question: `${C.warn("Retry the audit?")}`,
                      kind: "plugin_audit",
                      defaultChoice: "yes",
                    });
                if (answer === "yes") {
                  noteIcon("🔄", "Retrying audit...");
                  attemptAudit = true;
                  continue;
                }
              }
            }
          } else {
            const findings = pluginManager.runStaticScan(auditPluginName);
            noteIcon("📋", "Static scan only (no client):");
            for (const f of findings) {
              const icon =
                f.severity === "danger"
                  ? "🔴"
                  : f.severity === "warning"
                    ? "⚠️ "
                    : "ℹ️ ";
              note(
                `   ${icon} ${f.message}${f.line ? ` (line ${f.line})` : ""}`,
              );
            }
            if (findings.length === 0) {
              note("   ✅ No issues found.");
            }
          }
          blank();
          break;
        }

        // ── /plugin (no subcommand or unknown) ──────────
        default: {
          // Fuzzy-match the typo against known subcommands.
          const PLUGIN_SUBS = [
            "list",
            "enable",
            "disable",
            "approve",
            "unapprove",
            "audit",
          ];
          if (subCmd) {
            const best = closestMatch(subCmd, PLUGIN_SUBS);
            if (best) {
              note(
                `${C.warn("❓ Unknown subcommand")} "${subCmd}". Did you mean ${C.info('"' + best + '"')}?`,
              );
              note(`   /plugin ${best} ${parts.slice(2).join(" ")}`.trimEnd());
            } else {
              noteIcon("❓", `Unknown subcommand "${subCmd}".`);
            }
          }
          note("Usage: /plugin <list|enable|disable|approve|unapprove|audit>");
          note("   Type /help for details.");
          blank();
          break;
        }
      }

      return true;
    }

    case "/skills": {
      // Resolve built-in skills dir: in dev mode go up two levels
      // (src/agent/ → repo root), in binary mode runtime content is
      // alongside the bundle.
      const __scDirname = dirname(new URL(import.meta.url).pathname);
      const skillsDir = existsSync(join(__scDirname, "skills"))
        ? join(__scDirname, "skills")
        : resolve(__scDirname, "../..", "skills");

      const sub = parts[1]?.trim()?.toLowerCase() ?? "";
      const arg = parts[2]?.trim();

      // /skills info <name> — show full SKILL.md (user > system precedence)
      if (sub === "info") {
        if (!arg) {
          console.log(`  ${C.dim("Usage: /skills info <name>")}`);
          return true;
        }
        // Validate the name BEFORE touching the filesystem so a value
        // like "../etc" can never be `join`-ed into a path we read.
        const nameError = validateSkillName(arg);
        if (nameError) {
          console.log(`  ${C.err("❌ Invalid skill name:")} ${nameError}`);
          return true;
        }
        const userContent = readUserSkill(arg);
        if (userContent) {
          console.log(
            `  ${C.label("📚 User skill:")} ${C.tool(arg)} ${C.dim("(👤)")}\n`,
          );
          console.log(userContent);
          return true;
        }
        const systemFile = join(skillsDir, arg, "SKILL.md");
        if (existsSync(systemFile)) {
          const { readFileSync } = await import("node:fs");
          console.log(`  ${C.label("📚 System skill:")} ${C.tool(arg)}\n`);
          console.log(readFileSync(systemFile, "utf8"));
          return true;
        }
        console.log(`  ${C.err("❌ Skill not found:")} ${arg}`);
        return true;
      }

      // /skills edit <name> — print the user-skill path for $EDITOR.
      if (sub === "edit") {
        if (!arg) {
          console.log(`  ${C.dim("Usage: /skills edit <name>")}`);
          return true;
        }
        const nameError = validateSkillName(arg);
        if (nameError) {
          console.log(`  ${C.err("❌ Invalid skill name:")} ${nameError}`);
          return true;
        }
        if (!userSkillExists(arg)) {
          console.log(
            `  ${C.err("❌ User skill not found:")} ${arg} ` +
              `${C.dim("(system skills cannot be edited from the REPL)")}`,
          );
          return true;
        }
        const filePath = join(getUserSkillsDir(), arg, "SKILL.md");
        console.log(`  ${C.label("📝 Edit:")} ${filePath}`);
        console.log(
          `  ${C.dim("Open in your editor, save, then the change applies on next /suggest_approach.")}`,
        );
        return true;
      }

      // /skills delete <name> — remove a user skill (system ones are immutable).
      if (sub === "delete") {
        if (!arg) {
          console.log(`  ${C.dim("Usage: /skills delete <name>")}`);
          return true;
        }
        const nameError = validateSkillName(arg);
        if (nameError) {
          console.log(`  ${C.err("❌ Invalid skill name:")} ${nameError}`);
          return true;
        }
        if (!userSkillExists(arg)) {
          console.log(
            `  ${C.err("❌ User skill not found:")} ${arg} ` +
              `${C.dim("(system skills cannot be deleted)")}`,
          );
          return true;
        }
        // Confirm before deletion — destructive, no undo.
        await ui.drainPasteBuffer();
        const confirmed = state.autoApprove
          ? true
          : (await ui.askApproval({
              question: `${C.warn("🗑️  Delete user skill")} ${C.tool(arg)}?`,
              kind: "skill_delete",
              defaultChoice: "no",
            })) === "yes";
        if (!confirmed) {
          console.log(`  ${C.dim("Cancelled.")}`);
          return true;
        }
        deleteUserSkill(arg);
        console.log(`  ${C.ok("🗑️  Deleted user skill:")} ${arg}`);
        return true;
      }

      // /skills reload — hot-reload the SDK's skill registry so
      // freshly authored skills (via `/save-skill`, `generate_skill`,
      // or an external editor on `~/.hyperagent/skills/<name>/SKILL.md`)
      // become invocable without restarting the agent.  The SDK's
      // `ensureSkillsLoaded()` is one-shot per session, so without
      // this lever any mid-session skill writes are dead until the
      // process recycles — exactly the user-facing footgun this
      // fixes.  Calls the experimental `session.rpc.skills.reload()`
      // RPC which clears the loaded-skills cache, re-scans every
      // configured `skillDirectories` entry, and re-emits the
      // `<available_skills>` block to the model on its next turn.
      if (sub === "reload") {
        if (!state.activeSession) {
          console.log(
            `  ${C.err("❌ No active session — start the agent first.")}`,
          );
          return true;
        }
        try {
          await state.activeSession.rpc.skills.reload();
          console.log(
            `  ${C.ok("📚 Skills reloaded")} ${C.dim("— new skills are now invocable.")}`,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${C.err("❌ Skill reload failed:")} ${msg}`);
        }
        return true;
      }

      // /skills <name> — bridge to "/<name>" so the SDK's skill-
      // invocation grammar matches (Bug 3).  Previously this block
      // printed "Invoking skill" and forwarded the raw "/skills <name>"
      // text to the SDK, which doesn't speak that grammar — the LLM
      // saw it as natural language and sometimes mis-fired
      // generate_skill.  The REPL intake layer also rewrites this
      // form, but we cover synthetic callers (--skill flag, suggested
      // command auto-apply, /save-skill prompts) here as well.
      const skillArg = parts[1]?.trim();
      if (skillArg && sub !== "list") {
        return await handleSlashCommand(`/${skillArg}`, deps);
      }

      // /skills (no args) or /skills list — list system + user skills,
      // tagging user-authored ones with the 👤 badge.  Merged so the user
      // sees a single namespace and any user override is obvious.
      try {
        const { readdirSync, readFileSync } = await import("node:fs");
        type Row = {
          name: string;
          desc: string;
          source: "system" | "user";
          overridden: boolean;
        };
        const rows: Map<string, Row> = new Map();

        if (existsSync(skillsDir)) {
          const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(
            (d) => d.isDirectory(),
          );
          for (const dir of dirs) {
            const skillFile = join(skillsDir, dir.name, "SKILL.md");
            if (!existsSync(skillFile)) continue;
            const content = readFileSync(skillFile, "utf8");
            const descMatch = content.match(/^description:\s*(.+)$/m);
            rows.set(dir.name, {
              name: dir.name,
              desc: descMatch ? descMatch[1] : "(no description)",
              source: "system",
              overridden: false,
            });
          }
        }

        for (const info of listUserSkills()) {
          const content = readUserSkill(info.name);
          const descMatch = content?.match(/^description:\s*(.+)$/m);
          const wasSystem = rows.has(info.name);
          rows.set(info.name, {
            name: info.name,
            desc: descMatch ? descMatch[1] : "(no description)",
            source: "user",
            overridden: wasSystem,
          });
        }

        if (rows.size === 0) {
          console.log("  No skills found.");
          return true;
        }

        const sorted = Array.from(rows.values()).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        console.log(
          `  ${C.label("📚 Available skills")} (${sorted.length}):\n`,
        );
        for (const row of sorted) {
          const badge =
            row.source === "user"
              ? row.overridden
                ? " 👤 (overrides built-in)"
                : " 👤"
              : "";
          console.log(`     /${row.name}${badge}`);
          console.log(`     ${C.dim(row.desc)}\n`);
        }
        console.log(
          `  ${C.dim("Invoke: /<name> · Manage: /skills info|edit|delete <name> · Refresh: /skills reload")}`,
        );
      } catch {
        console.log("  Error reading skills directory.");
      }
      return true;
    }

    case "/save-skill": {
      // Capture session learnings as a user-authored SKILL.md.
      //
      // We don't author the SKILL.md ourselves — we hand a structured
      // summary of "what happened this session" to the LLM and ask it
      // to call the generate_skill tool with the right shape.  The
      // model has all the context (it's been the agent the whole time),
      // so it's better placed than the REPL to write the guidance text.
      const desiredName = parts[1]?.trim();
      if (!state.activeSession) {
        console.log(
          `  ${C.err("❌ No active session — start the agent first.")}`,
        );
        return true;
      }

      const ctx = extractSessionContext(state);
      if (ctx.totalToolCalls === 0 && !ctx.userPrompt) {
        console.log(
          `  ${C.warn("⚠️  Nothing to learn from yet — run a task first, then /save-skill.")}`,
        );
        return true;
      }

      const rendered = renderSessionContext(ctx);
      const nameDirective = desiredName
        ? `Use the name "${desiredName}" for the skill.`
        : "Pick a kebab-case name that summarises the workflow (e.g. 'teams-transcript-finder').";

      const promptLines = [
        "The user has asked me to save what we learned in this session as a reusable skill.",
        "Call the `generate_skill` tool with a SKILL.md that captures the workflow.",
        "",
        nameDirective,
        "",
        "Authoring rules:",
        "  • description: ≤280 chars, action-oriented (what the skill helps the user do).",
        "  • triggers: 3–10 distinctive phrases that future related prompts are likely to contain.",
        "  • guidance: concise markdown — workflow steps, gotchas, do/don't. NOT a transcript.",
        "  • requiresMcp: only include MCP servers actually needed by the workflow.",
        "  • allowedTools: the smallest set of tools needed to execute this workflow.",
        "  • companionModule: include ONLY if there's reusable JS that should ship with the skill.",
        "",
        "Session context to draw on:",
        "",
        rendered,
        "",
        "After calling `generate_skill`, briefly tell me what you saved and what it'll be triggered by.",
      ];
      const synthetic = promptLines.join("\n");

      console.log(
        `  ${C.label("📝 Capturing session learnings…")}` +
          (desiredName ? ` ${C.dim("(name: " + desiredName + ")")}` : ""),
      );
      // "distinct tools" = full-history cardinality, NOT the bounded
      // topTools view (capped at MAX_TOP_TOOLS).  Computing it from
      // toolCallHistory keeps the status line honest.
      const distinctToolCount = new Set(
        state.toolCallHistory.map((e) => e.tool),
      ).size;
      console.log(
        `  ${C.dim("Context: " + ctx.totalToolCalls + " tool calls, " + distinctToolCount + " distinct tools.")}`,
      );

      // Bypass auto suggest_approach on the next turn — the synthetic
      // prompt mentions "MCP", "SKILL.md", etc. as scaffolding and
      // would otherwise match unrelated skill triggers.
      deps.submitToLLM(synthetic, { skipAutoSuggest: true });
      return true;
    }

    case "/clear": {
      // ANSI escape: clear screen + move cursor to top-left
      process.stderr.write("\x1b[2J\x1b[H");
      return true;
    }

    case "/profile": {
      const subCmd = parts[1]?.toLowerCase() ?? "";
      const profileArg = parts.slice(2).join(" ").trim();

      if (subCmd === "" || subCmd === "list") {
        // /profile or /profile list — show all profiles
        const { formatAllProfiles } = await import("./profiles.js");
        console.log(`\n  📋 Available profiles:\n`);
        console.log(
          formatAllProfiles()
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
        );
        console.log(
          `\n  ${C.dim("Use /profile apply <name> [name2 ...] to apply.")}`,
        );
        console.log(
          `  ${C.dim("The LLM can also call apply_profile() directly.")}`,
        );
        console.log();
      } else if (subCmd === "apply") {
        if (!profileArg) {
          console.log(
            `  ${C.warn("Usage:")} /profile apply <name> [name2 ...]`,
          );
          console.log(
            `  ${C.dim("Stack multiple: /profile apply web-research heavy-compute")}`,
          );
          console.log();
          return true;
        }
        // Parse profile names (space-separated)
        const names = profileArg.split(/\s+/);
        const { mergeProfiles, getProfileNames } =
          await import("./profiles.js");
        const merged = mergeProfiles(names);
        if (merged.error) {
          console.log(`  ${C.err("❌ " + merged.error)}`);
          console.log();
          return true;
        }

        // Apply limits
        const { applySandboxConfig, getEffectiveConfig } =
          await import("./config-actions.js");

        const currentConfig = getEffectiveConfig(deps.sandbox, deps.state);
        const limitsToApply: Record<string, number> = {};

        if (
          merged.limits.cpuTimeoutMs !== undefined &&
          merged.limits.cpuTimeoutMs > currentConfig.cpuTimeoutMs
        )
          limitsToApply.cpuTimeout = merged.limits.cpuTimeoutMs;
        if (
          merged.limits.wallTimeoutMs !== undefined &&
          merged.limits.wallTimeoutMs > currentConfig.wallTimeoutMs
        )
          limitsToApply.wallTimeout = merged.limits.wallTimeoutMs;
        if (
          merged.limits.heapMb !== undefined &&
          merged.limits.heapMb > currentConfig.heapMb
        )
          limitsToApply.heap = merged.limits.heapMb;
        if (
          merged.limits.scratchMb !== undefined &&
          merged.limits.scratchMb > currentConfig.scratchMb
        )
          limitsToApply.scratch = merged.limits.scratchMb;
        if (
          merged.limits.inputBufferKb !== undefined &&
          merged.limits.inputBufferKb > currentConfig.inputBufferKb
        )
          limitsToApply.inputBuffer = merged.limits.inputBufferKb;
        if (
          merged.limits.outputBufferKb !== undefined &&
          merged.limits.outputBufferKb > currentConfig.outputBufferKb
        )
          limitsToApply.outputBuffer = merged.limits.outputBufferKb;

        if (Object.keys(limitsToApply).length > 0) {
          const configResult = await applySandboxConfig(
            deps.sandbox,
            deps.state,
            limitsToApply,
          );
          if (configResult.success) {
            console.log(
              `  ${C.ok("✅ Limits applied:")} ${configResult.message}`,
            );
            if (configResult.sandboxRebuilt) {
              deps.state.sessionNeedsRebuild = true;
            }
          } else {
            console.log(`  ${C.err("❌ " + configResult.error)}`);
          }
        } else {
          console.log(
            `  ${C.dim("Limits: current values already meet or exceed profile.")}`,
          );
        }

        // Enable required plugins
        for (const plugin of merged.plugins) {
          const existing = deps.pluginManager.getPlugin(plugin.name);
          if (existing?.state === "enabled") {
            console.log(`  ${C.dim(`Plugin ${plugin.name}: already enabled`)}`);
            continue;
          }
          // Delegate to /plugin enable
          const configStr = plugin.defaultConfig
            ? " " +
              Object.entries(plugin.defaultConfig)
                .map(([k, v]) => {
                  if (Array.isArray(v)) return `${k}=[${v.join(",")}]`;
                  return `${k}=${v}`;
                })
                .join(" ")
            : "";
          await handleSlashCommand(
            `/plugin enable ${plugin.name}${configStr}`,
            deps,
          );
        }

        const profileLabel = merged.appliedProfiles.join(" + ");
        console.log(`  ${C.ok("📋 Profile applied:")} ${profileLabel}`);
        console.log();
      } else if (subCmd === "show") {
        // /profile show — show current effective config
        const { getEffectiveConfig } = await import("./config-actions.js");
        const config = getEffectiveConfig(deps.sandbox, deps.state);
        console.log(`\n  📋 Current effective configuration:`);
        console.log(`     CPU timeout:    ${config.cpuTimeoutMs}ms`);
        console.log(`     Wall timeout:   ${config.wallTimeoutMs}ms`);
        console.log(`     Heap:           ${config.heapMb}MB`);
        console.log(`     Scratch:        ${config.scratchMb}MB`);
        console.log(`     Input buffer:   ${config.inputBufferKb}KB`);
        console.log(`     Output buffer:  ${config.outputBufferKb}KB`);

        // Show enabled plugins
        const enabled = deps.pluginManager
          .listPlugins()
          .filter((p) => p.state === "enabled");
        if (enabled.length > 0) {
          console.log(
            `     Plugins:        ${enabled.map((p) => p.manifest.name).join(", ")}`,
          );
        } else {
          console.log(`     Plugins:        none`);
        }
        console.log();
      } else {
        console.log(`  ${C.warn("Usage:")} /profile [list|apply|show]`);
        console.log(
          `  ${C.dim("/profile list              — show available profiles")}`,
        );
        console.log(
          `  ${C.dim("/profile apply <name> ...  — apply profile(s)")}`,
        );
        console.log(
          `  ${C.dim("/profile show              — show current config")}`,
        );
        console.log();
      }
      return true;
    }

    case "/module": {
      const subCmd = parts[1]?.toLowerCase() ?? "";
      const moduleArg = parts.slice(2).join(" ").trim();

      if (subCmd === "" || subCmd === "list") {
        // /module list — show all modules
        const { listModules } = await import("./module-store.js");
        const { formatExports } = await import("./format-exports.js");
        const modules = listModules();
        if (modules.length === 0) {
          console.log(`\n  ${C.dim("No modules registered.")}`);
        } else {
          console.log(`\n  📦 Modules (${modules.length}):\n`);
          for (const m of modules) {
            const badge = m.author === "system" ? C.dim("[system]") : "[user]";
            const lock = m.mutable ? "" : " 🔒";
            console.log(
              `  ${C.tool(m.name)} ${badge}${lock} — ${m.description}`,
            );
            const exStr = formatExports(m.exports);
            if (exStr !== "(no exports found)") {
              for (const line of exStr.split("\n")) {
                console.log(`    ${C.dim(line)}`);
              }
            }
          }
        }
        console.log(
          `\n  ${C.dim('Import in handlers: import { fn } from "ha:<name>"')}`,
        );
        console.log();
      } else if (subCmd === "info") {
        if (!moduleArg) {
          console.log(`  ${C.warn("Usage:")} /module info <name>`);
          console.log();
          return true;
        }
        const { loadModule } = await import("./module-store.js");
        const { formatExports } = await import("./format-exports.js");
        const info = loadModule(moduleArg);
        if (!info) {
          console.log(`  ${C.err("❌ Module not found: " + moduleArg)}`);
          console.log();
          return true;
        }
        const badge = info.author === "system" ? "[system]" : "[user]";
        console.log(`\n  📦 ${C.tool(info.name)} ${badge}`);
        console.log(`     ${info.description}`);
        console.log(`     Author: ${info.author}`);
        console.log(`     Mutable: ${info.mutable}`);
        console.log(`     Created: ${info.created}`);
        console.log(`     Modified: ${info.modified}`);
        console.log(`     Size: ${info.sizeBytes} bytes`);
        console.log(`     Import: import { ... } from "ha:${info.name}"`);
        console.log(`\n     Exports:`);
        const exStr = formatExports(info.exports);
        for (const line of exStr.split("\n")) {
          console.log(`       ${line}`);
        }
        console.log(`\n     Source:`);
        for (const line of info.source.split("\n").slice(0, 30)) {
          console.log(`       ${C.dim(line)}`);
        }
        if (info.source.split("\n").length > 30) {
          console.log(
            `       ${C.dim(`... (${info.source.split("\n").length - 30} more lines)`)}`,
          );
        }
        console.log();
      } else if (subCmd === "delete") {
        if (!moduleArg) {
          console.log(`  ${C.warn("Usage:")} /module delete <name>`);
          console.log();
          return true;
        }
        const { loadModule, deleteModuleFromDisk } =
          await import("./module-store.js");
        const info = loadModule(moduleArg);
        if (!info) {
          console.log(`  ${C.err("❌ Module not found: " + moduleArg)}`);
          console.log();
          return true;
        }
        if (info.author === "system") {
          console.log(
            `  ${C.err("❌ Cannot delete system module: " + moduleArg)}`,
          );
          console.log();
          return true;
        }
        try {
          deleteModuleFromDisk(moduleArg);
          // Also remove from sandbox cache so it's no longer importable
          await deps.sandbox.deleteModule(moduleArg);
          console.log(`  ${C.ok("🗑️  Module deleted:")} ${moduleArg}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${C.err("❌ " + msg)}`);
        }
        console.log();
      } else if (subCmd === "lock") {
        if (!moduleArg) {
          console.log(`  ${C.warn("Usage:")} /module lock <name>`);
          console.log();
          return true;
        }
        const { setModuleMutable } = await import("./module-store.js");
        try {
          setModuleMutable(moduleArg, false);
          console.log(`  ${C.ok("🔒 Module locked:")} ${moduleArg}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${C.err("❌ " + msg)}`);
        }
        console.log();
      } else if (subCmd === "unlock") {
        if (!moduleArg) {
          console.log(`  ${C.warn("Usage:")} /module unlock <name>`);
          console.log();
          return true;
        }
        const { setModuleMutable } = await import("./module-store.js");
        try {
          setModuleMutable(moduleArg, true);
          console.log(`  ${C.ok("🔓 Module unlocked:")} ${moduleArg}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${C.err("❌ " + msg)}`);
        }
        console.log();
      } else {
        console.log(
          `  ${C.warn("Usage:")} /module [list|info|delete|lock|unlock]`,
        );
        console.log(
          `  ${C.dim("/module list              — show all modules")}`,
        );
        console.log(
          `  ${C.dim("/module info <name>       — detailed module info")}`,
        );
        console.log(
          `  ${C.dim("/module delete <name>     — delete user module")}`,
        );
        console.log(
          `  ${C.dim("/module lock <name>       — protect from modification")}`,
        );
        console.log(
          `  ${C.dim("/module unlock <name>     — allow modification")}`,
        );
        console.log();
      }
      return true;
    }

    // ── MCP Commands ─────────────────────────────────────────
    //
    // MCP server management. Only available when the mcp plugin is enabled.

    case "/mcp": {
      // Gate: MCP plugin must be enabled
      const mcpPlugin = deps.pluginManager.getPlugin("mcp");
      if (!mcpPlugin || mcpPlugin.state !== "enabled") {
        console.log(
          `  ${C.err("MCP plugin not enabled.")} Run ${C.info("/plugin enable mcp")} first.`,
        );
        console.log();
        return true;
      }

      if (!deps.mcpManager) {
        console.log(`  ${C.err("MCP manager not initialised.")}`);
        console.log();
        return true;
      }

      const mcpSubCmd = parts[1]?.toLowerCase();
      const mcpName = parts[2];

      switch (mcpSubCmd) {
        // ── /mcp list ────────────────────────────────────
        case "list": {
          const servers = deps.mcpManager.listServers();
          if (servers.length === 0) {
            console.log(
              `  No MCP servers configured. Add servers to ${C.dim("~/.hyperagent/config.json")}`,
            );
          } else {
            console.log(`  ${C.label("MCP Servers")} (${servers.length}):\n`);
            for (const s of servers) {
              const stateColor =
                s.state === "connected"
                  ? C.ok(s.state)
                  : s.state === "error"
                    ? C.err(s.state)
                    : C.dim(s.state);
              const tools =
                s.state === "connected" ? ` — ${s.tools.length} tool(s)` : "";
              console.log(`  ${C.label(s.name)}  [${stateColor}]${tools}`);
              console.log(`    ${C.dim(mcpConfigDisplayString(s.config))}`);
            }
          }
          console.log();
          return true;
        }

        // ── /mcp enable <name> ───────────────────────────
        case "enable": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp enable <server-name>")}`);
            console.log();
            return true;
          }

          const conn = deps.mcpManager.getConnection(mcpName);
          if (!conn) {
            console.log(
              `  ${C.err(`Unknown MCP server: "${mcpName}"`)}. Check ~/.hyperagent/config.json`,
            );
            console.log();
            return true;
          }

          if (conn.state === "connected") {
            console.log(`  ${C.ok(`"${mcpName}" is already connected.`)}`);
            console.log();
            return true;
          }

          try {
            // For OAuth servers in auto-approve mode, check if we can
            // authenticate silently. If not, interactive auth would
            // open a browser that nobody's watching (yolo/CI mode).
            // Refuse early instead of hanging.
            if (
              deps.state.autoApprove &&
              isMCPHttpConfig(conn.config) &&
              conn.config.auth?.method === "oauth"
            ) {
              const canSilent = await canAcquireSilently(
                mcpName,
                conn.config.auth,
              );
              if (!canSilent) {
                console.log(
                  `  ${C.err(`"${mcpName}" requires interactive authentication but running in auto-approve mode.`)}`,
                );
                console.log(
                  `  ${C.dim("Run without --auto-approve first to authenticate, then tokens will be cached for future runs.")}`,
                );
                console.log();
                return true;
              }
            }

            // Connect and discover tools
            console.log(`  Connecting to ${C.label(mcpName)}...`);
            const connected = await deps.mcpManager.connect(mcpName);

            // Audit tool descriptions
            const warnings = auditMCPTools(connected.tools);

            // Check approval
            const approvalStore = loadMCPApprovalStore();
            const approved = isMCPApproved(mcpName, conn.config, approvalStore);

            if (!approved) {
              // Show approval prompt
              console.log();
              console.log(`  ${C.label("MCP Server Approval Required")}`);
              console.log();
              console.log(`  Server:  ${C.label(mcpName)}`);
              console.log(
                `  ${isMCPStdioConfig(conn.config) ? "Command" : "URL"}:    ${C.dim(mcpConfigDisplayString(conn.config))}`,
              );

              if (isMCPStdioConfig(conn.config) && conn.config.env) {
                console.log(`  Env vars:`);
                for (const [k, v] of Object.entries(conn.config.env)) {
                  console.log(`    ${k}=${C.dim(maskEnvValue(v))}`);
                }
              }

              console.log();
              console.log(`  Tools (${connected.tools.length}):`);
              for (const tool of connected.tools) {
                console.log(
                  `    ${C.label(tool.name)} — ${tool.description.slice(0, 80)}`,
                );
              }

              if (warnings.length > 0) {
                console.log();
                console.log(`  ${C.err("⚠️  Audit Warnings:")}`);
                for (const w of warnings) {
                  console.log(`    ${C.err("• " + w)}`);
                }
              }

              console.log();
              console.log(
                `  ${C.err("⚠️  This MCP server runs as a full OS process with YOUR permissions.")}`,
              );
              console.log(`  ${C.err("   It is NOT sandboxed.")}`);
              console.log();

              // Auto-approve in auto-approve mode
              if (deps.state.autoApprove) {
                console.log(`  ${C.ok("Auto-approved")} (--auto-approve mode)`);
              } else {
                await deps.ui.drainPasteBuffer();
                const answer = await ui.askApproval({
                  question: `Approve "${mcpName}"?`,
                  kind: "mcp_server",
                  defaultChoice: "no",
                });
                if (answer !== "yes") {
                  console.log(`  ${C.dim("Cancelled.")}`);
                  await deps.mcpManager.disconnect(mcpName);
                  console.log();
                  return true;
                }
              }

              // Store approval
              approveMCPServer(
                mcpName,
                conn.config,
                connected.tools.map((t) => t.name),
                warnings,
                approvalStore,
              );
            }

            // Sync to sandbox
            await deps.syncPlugins();

            console.log(
              `  ${C.ok(`✓ "${mcpName}" enabled`)} — ${connected.tools.length} tool(s) available as ${C.dim(`host:mcp-${mcpName}`)}`,
            );
          } catch (err) {
            console.log(
              `  ${C.err(`Failed to enable "${mcpName}": ${(err as Error).message}`)}`,
            );
          }
          console.log();
          return true;
        }

        // ── /mcp disable <name> ──────────────────────────
        case "disable": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp disable <server-name>")}`);
            console.log();
            return true;
          }

          await deps.mcpManager.disconnect(mcpName);
          await deps.syncPlugins();
          console.log(`  ${C.ok(`"${mcpName}" disconnected.`)}`);
          console.log();
          return true;
        }

        // ── /mcp info <name> ─────────────────────────────
        case "info": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp info <server-name>")}`);
            console.log();
            return true;
          }

          const info = deps.mcpManager.getConnection(mcpName);
          if (!info) {
            console.log(`  ${C.err(`Unknown MCP server: "${mcpName}"`)}`);
            console.log();
            return true;
          }

          console.log(`  ${C.label(mcpName)}`);
          console.log(`  State:   ${info.state}`);
          console.log(
            `  ${isMCPStdioConfig(info.config) ? "Command" : "URL"}:    ${mcpConfigDisplayString(info.config)}`,
          );
          if (info.config.allowTools) {
            console.log(`  Allow:   ${info.config.allowTools.join(", ")}`);
          }
          if (info.config.denyTools) {
            console.log(`  Deny:    ${info.config.denyTools.join(", ")}`);
          }

          if (info.tools.length > 0) {
            console.log();
            console.log(`  Tools (${info.tools.length}):`);
            for (const tool of info.tools) {
              console.log(`    ${C.label(tool.name)}`);
              console.log(`      ${C.dim(tool.description.slice(0, 120))}`);
            }

            console.log();
            console.log(`  ${C.dim("TypeScript declarations:")}`);
            console.log(C.dim(generateMCPDeclarations(mcpName, info.tools)));
          }
          console.log();
          return true;
        }

        // ── /mcp approve <name> ──────────────────────────
        case "approve": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp approve <server-name>")}`);
            console.log();
            return true;
          }

          const conn2 = deps.mcpManager.getConnection(mcpName);
          if (!conn2) {
            console.log(`  ${C.err(`Unknown MCP server: "${mcpName}"`)}`);
            console.log();
            return true;
          }

          const store = loadMCPApprovalStore();
          approveMCPServer(mcpName, conn2.config, [], [], store);
          console.log(`  ${C.ok(`"${mcpName}" pre-approved.`)}`);
          console.log();
          return true;
        }

        // ── /mcp revoke <name> ───────────────────────────
        case "revoke": {
          if (!mcpName) {
            console.log(`  Usage: ${C.info("/mcp revoke <server-name>")}`);
            console.log();
            return true;
          }

          const store2 = loadMCPApprovalStore();
          if (revokeMCPApproval(mcpName, store2)) {
            console.log(`  ${C.ok(`Approval revoked for "${mcpName}".`)}`);
          } else {
            console.log(`  ${C.dim(`"${mcpName}" was not approved.`)}`);
          }
          console.log();
          return true;
        }

        default: {
          console.log(`  ${C.label("MCP Commands:")}`);
          console.log(
            `  ${C.dim("/mcp list              — show configured servers")}`,
          );
          console.log(
            `  ${C.dim("/mcp enable <name>     — approve and connect")}`,
          );
          console.log(`  ${C.dim("/mcp disable <name>    — disconnect")}`);
          console.log(
            `  ${C.dim("/mcp info <name>       — show tools and details")}`,
          );
          console.log(`  ${C.dim("/mcp approve <name>    — pre-approve")}`);
          console.log(`  ${C.dim("/mcp revoke <name>     — remove approval")}`);
          console.log();
          return true;
        }
      }
    }

    case "/help": {
      const helpTopic = parts.slice(1).join(" ").trim();
      if (helpTopic) {
        const topicHelp = renderTopicHelp(helpTopic);
        if (topicHelp) {
          console.log(topicHelp);
        } else {
          console.log(`  ❓ No help found for "${helpTopic}".`);
          console.log(
            "     Try /help plugin, /help timeout, or /help <command>.",
          );
          console.log();
        }
      } else {
        console.log(renderHelp());
      }
      return true;
    }

    default: {
      // Check if it's a skill invocation — skills are handled by the SDK,
      // not by our slash command handler. Return false to pass through.
      //
      // System skills live under <CONTENT_ROOT>/skills/, user skills
      // under getUserSkillsDir().  The SDK has both in skillDirectories
      // so it can invoke either — we just need to recognise both here
      // so the "Invoking skill" log fires and the input gets forwarded
      // instead of reported as unknown.
      //
      // SECURITY: we MUST validate `skillName` before any fs operation —
      // `cmd.slice(1)` is unsanitised user input and a literal
      // `/../etc/passwd` would otherwise turn this into a filesystem
      // probe via `join(skillsDir, skillName, ...)` (PR #151 review).
      // `systemSkillExists` validates via `validateSkillName` first,
      // rejecting empty / oversized / path-traversal / reserved names
      // before touching disk.  `userSkillExists` does the same.
      const __scDir = dirname(new URL(import.meta.url).pathname);
      const skillsDir = existsSync(join(__scDir, "skills"))
        ? join(__scDir, "skills")
        : resolve(__scDir, "../..", "skills");
      try {
        const skillName = cmd.slice(1); // remove leading /
        if (
          systemSkillExists(skillName, skillsDir) ||
          userSkillExists(skillName)
        ) {
          console.log(`  ${C.info("📚")} Invoking skill: ${C.tool(skillName)}`);
          return false; // Let SDK handle it
        }
      } catch {
        // Ignore — fall through to unknown command
      }

      console.log(
        `  ${C.warn("❓ Unknown command:")} ${cmd}. Type ${C.info("/help")} for available commands.`,
      );
      console.log();
      return true;
    }
  }
}
