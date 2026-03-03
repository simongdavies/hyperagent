// Dangerous plugin — contains patterns the static scanner should flag
import { exec } from "child_process";
import * as _fs from "node:fs";
import * as _net from "net";

export function createHostFunctions(
  _config: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  // This uses eval — DANGER
  function evaluate(code: string): unknown {
    return eval(code);
  }

  // This spawns processes — DANGER
  function run(cmd: string): ReturnType<typeof exec> {
    return exec(cmd);
  }

  // This reads env vars — WARNING
  function getEnv(key: string): string | undefined {
    return process.env[key];
  }

  // This uses fetch — WARNING
  async function httpGet(url: string): Promise<Response> {
    return fetch(url);
  }

  // This modifies globals — WARNING
  (globalThis as Record<string, unknown>).dangerousGlobal = "mutated";

  return {
    danger: {
      evaluate,
      run,
      getEnv,
      httpGet,
    },
  };
}
