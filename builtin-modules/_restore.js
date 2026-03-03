// ── Internal Restore Module ──────────────────────────────────────────
//
// Used by the sandbox auto-preservation system to repopulate
// ha:shared-state after a sandbox rebuild. The data was previously
// captured by the ha:_save module and stashed via the host:_state-sidecar
// host function.
//
// Binary data (Uint8Array) IS preserved via the host sidecar mechanism.
// Each value is retrieved separately so binary data is always a
// TOP-LEVEL return value, going through Hyperlight's binary sidecar.
//
// NOT user-facing — hidden from list_modules / module_info by the
// underscore-prefix convention.
//
// ─────────────────────────────────────────────────────────────────────

import { set, clear } from "ha:shared-state";
import * as sidecar from "host:_state-sidecar";

/**
 * Restore shared-state from the host-side stash via sidecar.
 * Clears existing state first, then repopulates from the snapshot.
 * Each value is retrieved separately so Uint8Array values go through
 * the binary sidecar correctly.
 *
 * @returns {number} Number of entries restored
 */
export function restore() {
  clear();

  // Check if there's anything to restore
  if (!sidecar.hasStash()) return 0;

  const allKeys = sidecar.listKeys();
  let count = 0;
  for (const k of allKeys) {
    const v = sidecar.retrieveKey(k);
    if (v !== undefined) {
      set(k, v);
      count++;
    }
  }

  return count;
}
