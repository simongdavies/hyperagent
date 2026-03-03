// ── Internal Save Module ─────────────────────────────────────────────
//
// Used by the sandbox auto-preservation system to capture the current
// contents of ha:shared-state before a sandbox rebuild (handler
// registration, deletion, config change, etc.).
//
// Binary data (Uint8Array) IS preserved via the host:_state-sidecar
// mechanism. Each value is stashed separately so binary data is always
// a TOP-LEVEL argument to the host function, going through Hyperlight's
// binary sidecar channel. Nested Uint8Arrays in objects do NOT work!
//
// NOT user-facing — hidden from list_modules / module_info by the
// underscore-prefix convention.
//
// ─────────────────────────────────────────────────────────────────────

import { keys, get } from "ha:shared-state";
import * as sidecar from "host:_state-sidecar";

/**
 * Capture all shared-state entries and stash them via host sidecar.
 * Each key-value is stashed separately so Uint8Array values are
 * top-level arguments and go through the binary sidecar correctly.
 * @returns {number} Number of entries saved
 */
export function save() {
  // Clear existing stash before saving new state
  sidecar.clearStash();

  const allKeys = keys();
  let count = 0;
  for (const k of allKeys) {
    const v = get(k);
    sidecar.stashKey(k, v);
    count++;
  }
  return count;
}
