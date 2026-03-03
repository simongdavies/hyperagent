#!/usr/bin/env node
// Patches vscode-jsonrpc to add exports field for ESM compatibility.
// Required because @github/copilot-sdk imports "vscode-jsonrpc/node"
// without .js extension, which doesn't resolve in ESM without exports.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Check both possible locations (hoisted vs nested)
const locations = [
  join(__dirname, "../node_modules/vscode-jsonrpc/package.json"),
  join(
    __dirname,
    "../node_modules/@github/copilot-sdk/node_modules/vscode-jsonrpc/package.json",
  ),
];

let patched = false;
for (const pkgPath of locations) {
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  if (pkg.exports) {
    console.log(`[patch] ${pkgPath} already has exports, skipping`);
    continue;
  }

  // Add exports field to enable subpath imports
  pkg.exports = {
    ".": {
      types: "./lib/common/api.d.ts",
      default: "./lib/node/main.js",
    },
    "./node": {
      types: "./lib/node/main.d.ts",
      default: "./lib/node/main.js",
    },
    "./node.js": {
      types: "./lib/node/main.d.ts",
      default: "./lib/node/main.js",
    },
    "./browser": {
      types: "./lib/browser/main.d.ts",
      default: "./lib/browser/main.js",
    },
  };

  writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
  console.log(`[patch] Added exports field to ${pkgPath}`);
  patched = true;
}

if (!patched) {
  console.log("[patch] vscode-jsonrpc not found or already patched");
}
