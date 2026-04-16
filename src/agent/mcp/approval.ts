// ── MCP approval store ───────────────────────────────────────────────
//
// Manages approval records for MCP servers. Approval is required
// before a server can be connected. Approval is invalidated if the
// server config (command + args) changes.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type {
  MCPServerConfig,
  MCPApprovalRecord,
  MCPApprovalStore,
} from "./types.js";
import { computeMCPConfigHash } from "./config.js";
import { auditDescription } from "./sanitise.js";

const APPROVAL_FILE = join(homedir(), ".hyperagent", "approved-mcp.json");

/**
 * Load the MCP approval store from disk.
 */
export function loadMCPApprovalStore(): MCPApprovalStore {
  try {
    if (!existsSync(APPROVAL_FILE)) return {};
    const raw = readFileSync(APPROVAL_FILE, "utf8");
    return JSON.parse(raw) as MCPApprovalStore;
  } catch {
    return {};
  }
}

/**
 * Save the MCP approval store to disk.
 */
function saveMCPApprovalStore(store: MCPApprovalStore): void {
  try {
    writeFileSync(APPROVAL_FILE, JSON.stringify(store, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    console.error(
      `[mcp] Failed to save approval store: ${(err as Error).message}`,
    );
  }
}

/**
 * Check if an MCP server is approved with its current config.
 */
export function isMCPApproved(
  name: string,
  config: MCPServerConfig,
  store: MCPApprovalStore,
): boolean {
  const record = store[name];
  if (!record) return false;

  const currentHash = computeMCPConfigHash(name, config);
  return record.configHash === currentHash;
}

/**
 * Approve an MCP server. Stores the config hash and audit results.
 *
 * @param name - Server name.
 * @param config - Server configuration.
 * @param tools - Discovered tool names.
 * @param auditWarnings - Warnings from tool description auditing.
 * @param store - The approval store (mutated in place and saved).
 */
export function approveMCPServer(
  name: string,
  config: MCPServerConfig,
  tools: string[],
  auditWarnings: string[],
  store: MCPApprovalStore,
): void {
  const record: MCPApprovalRecord = {
    configHash: computeMCPConfigHash(name, config),
    approvedAt: new Date().toISOString(),
    approvedTools: tools,
    auditWarnings,
  };

  store[name] = record;
  saveMCPApprovalStore(store);
}

/**
 * Revoke approval for an MCP server.
 */
export function revokeMCPApproval(
  name: string,
  store: MCPApprovalStore,
): boolean {
  if (!(name in store)) return false;
  delete store[name];
  saveMCPApprovalStore(store);
  return true;
}

/**
 * Audit all tools from an MCP server for prompt injection risks.
 * Returns a list of warning strings (empty if clean).
 */
export function auditMCPTools(
  tools: Array<{ name: string; description: string }>,
): string[] {
  const warnings: string[] = [];
  for (const tool of tools) {
    warnings.push(...auditDescription(tool.name, tool.description));
  }
  return warnings;
}
