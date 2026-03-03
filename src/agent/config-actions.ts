// ── agent/config-actions.ts — Shared configuration actions ───────────
//
// Pure functions for applying configuration changes to the sandbox.
// Used by BOTH slash commands (/set, /timeout, /buffer) and the
// LLM-facing configure_sandbox tool. Single source of truth.
//
// ─────────────────────────────────────────────────────────────────────

import type { AgentState } from "./state.js";
import type { SandboxTool } from "../sandbox/tool.js";

/** Result of a configuration action. */
export interface ConfigResult {
  success: boolean;
  /** What was changed — shown to user and LLM. */
  message?: string;
  /** Error description on failure. */
  error?: string;
  /** Whether the sandbox will be rebuilt (state lost). */
  sandboxRebuilt?: boolean;
  /** Current effective values after the change. */
  effective?: Record<string, number>;
}

/**
 * Apply sandbox configuration changes.
 * Only provided fields are changed — others remain unchanged.
 *
 * @param sandbox — The sandbox tool instance
 * @param state   — Agent state (for timeout overrides)
 * @param changes — Fields to change
 * @returns ConfigResult with what was changed
 */
export async function applySandboxConfig(
  sandbox: SandboxTool,
  state: AgentState,
  changes: {
    heap?: number;
    scratch?: number;
    cpuTimeout?: number;
    wallTimeout?: number;
    inputBuffer?: number;
    outputBuffer?: number;
  },
): Promise<ConfigResult> {
  const applied: string[] = [];
  let sandboxRebuilt = false;

  // ── Memory settings (trigger sandbox rebuild) ──────────────
  if (changes.heap !== undefined || changes.scratch !== undefined) {
    await sandbox.setMemorySizes(changes.heap, changes.scratch);
    sandboxRebuilt = true;
    if (changes.heap !== undefined) applied.push(`heap=${changes.heap}MB`);
    if (changes.scratch !== undefined)
      applied.push(`scratch=${changes.scratch}MB`);
  }

  // ── Buffer settings (trigger sandbox rebuild) ──────────────
  if (changes.inputBuffer !== undefined || changes.outputBuffer !== undefined) {
    await sandbox.setBufferSizes(changes.inputBuffer, changes.outputBuffer);
    sandboxRebuilt = true;
    if (changes.inputBuffer !== undefined)
      applied.push(`inputBuffer=${changes.inputBuffer}KB`);
    if (changes.outputBuffer !== undefined)
      applied.push(`outputBuffer=${changes.outputBuffer}KB`);
  }

  // ── Timeout settings (state-only, no rebuild) ──────────────
  if (changes.cpuTimeout !== undefined) {
    state.cpuTimeoutOverride = changes.cpuTimeout;
    applied.push(`cpuTimeout=${changes.cpuTimeout}ms`);
  }
  if (changes.wallTimeout !== undefined) {
    state.wallTimeoutOverride = changes.wallTimeout;
    applied.push(`wallTimeout=${changes.wallTimeout}ms`);
  }

  if (applied.length === 0) {
    return { success: false, error: "No configuration changes specified" };
  }

  // Build the effective config snapshot.
  const memory = sandbox.getEffectiveMemorySizes();
  const buffers = sandbox.getEffectiveBufferSizes();
  const effective = {
    heapMb: memory.heapMb,
    scratchMb: memory.scratchMb,
    cpuTimeoutMs: state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs,
    wallTimeoutMs:
      state.wallTimeoutOverride ?? sandbox.config.wallClockTimeoutMs,
    inputBufferKb: buffers.inputKb,
    outputBufferKb: buffers.outputKb,
  };

  return {
    success: true,
    message: `Configuration updated: ${applied.join(", ")}`,
    sandboxRebuilt,
    effective,
  };
}

/**
 * Get the current effective configuration as a snapshot.
 * Useful for returning to the LLM so it knows the current state.
 */
export function getEffectiveConfig(
  sandbox: SandboxTool,
  state: AgentState,
): Record<string, number> {
  const memory = sandbox.getEffectiveMemorySizes();
  const buffers = sandbox.getEffectiveBufferSizes();
  return {
    heapMb: memory.heapMb,
    scratchMb: memory.scratchMb,
    cpuTimeoutMs: state.cpuTimeoutOverride ?? sandbox.config.cpuTimeoutMs,
    wallTimeoutMs:
      state.wallTimeoutOverride ?? sandbox.config.wallClockTimeoutMs,
    inputBufferKb: buffers.inputKb,
    outputBufferKb: buffers.outputKb,
  };
}
