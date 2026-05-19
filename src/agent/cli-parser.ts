// ── CLI Argument Parsing ─────────────────────────────────────────────
//
// Parses process.argv into a typed config object. CLI flags override
// environment variables, which override hardcoded defaults.
//
// Pure module — no imports from agent state or other agent/* modules.
//
// ─────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import type { MCPSetupCommand } from "./mcp/setup-commands.js";

/**
 * Reasoning-effort levels accepted by the Copilot SDK session config.
 * The CLI flag handler and the env-var initialiser both validate against
 * this list so an unexpected value (e.g. `HYPERAGENT_REASONING_EFFORT=potato`)
 * is rejected before it can reach the SDK and cause a runtime error.
 */
const VALID_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/**
 * Normalise a reasoning-effort string from env or CLI: lowercase, then
 * accept only values in {@link VALID_REASONING_EFFORTS}. Anything else
 * (including `undefined`/empty) maps to `""` which the agent treats as
 * "unset" — the SDK falls back to the model's default.
 */
function normaliseReasoningEffort(raw: string | undefined): string {
  if (!raw) return "";
  const lower = raw.toLowerCase();
  return (VALID_REASONING_EFFORTS as readonly string[]).includes(lower)
    ? lower
    : "";
}

/**
 * Trim a base-dir string from env or CLI. A value of `"   "` (whitespace-only)
 * becomes `""`, which the agent treats as "unset" and skips the fs-read /
 * fs-write auto-enable block — avoiding the surprising failure mode where
 * `resolve("")` returns `process.cwd()` and silently makes CWD the sandbox.
 */
function normaliseBaseDir(raw: string | undefined): string {
  return raw?.trim() ?? "";
}

export interface CliConfig {
  model: string;
  cpuTimeout: string;
  wallTimeout: string;
  sendTimeout: string;
  heapSize: string;
  scratchSize: string;
  showCode: boolean;
  showTiming: boolean;
  /**
   * Reasoning effort level requested for the session, one of
   * "low" | "medium" | "high" | "xhigh" — or "" when unset.
   * Wired to `state.reasoningEffort` at startup. CLI: `--reasoning-effort <level>`
   * (default: "high" when flag given without value). Env: HYPERAGENT_REASONING_EFFORT.
   */
  reasoningEffort: string;
  verbose: boolean;
  /**
   * Very-verbose output: show full result bodies for *all* tools, including
   * non-sandbox protocol tools (plugin_info, module_info, register_handler,
   * suggest_approach, etc.). Plain `--verbose` only shows full bodies for
   * `execute_javascript` / `execute_bash`; `--very-verbose` adds the rest.
   * CLI: `--very-verbose` or `-vv`. Env: HYPERAGENT_VERY_VERBOSE.
   * Implies `--verbose`; standalone `-vv` enables both.
   */
  veryVerbose: boolean;
  /** Render LLM markdown output with ANSI formatting (headings, code, lists). */
  markdown: boolean;
  transcript: boolean;
  listModels: boolean;
  resumeSession: string;
  pluginsDir: string;
  debug: boolean;
  /** Capture LLM tuning data (decision logs) to a JSONL file. */
  tune: boolean;
  /**
   * Profile(s) to apply at startup (limits only, plugins need interactive
   * enable). Space-separated for stacking: "web-research heavy-compute".
   */
  profile: string;
  /**
   * Auto-approve all interactive prompts (plugin enable, config changes,
   * audit approvals, module registration). YOLO mode. 🎸
   */
  autoApprove: boolean;
  /**
   * Base directory for the fs-read and fs-write plugins. When set, both
   * plugins are auto-enabled at startup with this directory as their
   * `baseDir` config, replacing the default "unique-temp-dir" sandbox.
   * CLI: `--base-dir <path>`. Env: HYPERAGENT_BASE_DIR.
   * Independent of `--auto-approve` / `--yolo` (works on its own).
   * Path is resolved relative to cwd; created if missing; symlinks rejected.
   */
  baseDir: string;
  /**
   * Non-interactive prompt — send this message, wait for completion, exit.
   * Combines with --auto-approve for fully autonomous operation.
   */
  prompt: string;
  /**
   * Read prompt from a file instead of CLI arg. Avoids shell quoting
   * hell when the prompt contains quotes, newlines, or special chars.
   * CLI --prompt takes precedence over --prompt-file.
   */
  promptFile: string;
  /**
   * Skill(s) to invoke before the prompt. Space-separated names.
   * Skills inject domain expertise into the conversation.
   */
  skill: string;
  /**
   * Skip suggest_approach mandatory enforcement.
   * When true, the LLM can call any tool without calling suggest_approach first.
   */
  skipSuggest: boolean;
  /**
   * Large tool output threshold in bytes. Results exceeding this size
   * are saved to the results/ directory and the LLM receives a summary
   * with instructions to use read_output for the full data.
   */
  outputThreshold: string;
  /**
   * Show version and exit.
   */
  showVersion: boolean;
  /**
   * Strip ANSI colour/attribute codes from terminal output.
   * Cursor-control codes (used by the spinner) are preserved so
   * line-clearing still works.
   */
  noColor: boolean;
  /**
   * Suppress informational notifications (`level: "info"`).
   * Warnings, errors and success messages still emit.
   */
  quiet: boolean;
  /**
   * File path(s) to attach to the first user message. Repeatable
   * (`--attach a.png --attach b.csv`) and order-preserving. Each path is
   * resolved + validated at startup; the SDK reads, MIME-sniffs and
   * uploads each file. Empty array = no attachments (the common case).
   */
  attach: string[];
  /**
   * Headless mode: drive the agent over newline-delimited JSON on
   * stdio instead of the interactive REPL. Used by the Electron
   * desktop app and other embedding hosts. Disables readline, ANSI
   * output, transcript stdout-tee and every other terminal-only
   * affordance; every visible side-effect is serialised as a JSON
   * frame on stdout via {@link JsonLinesUI}. See `docs/IPC-PROTOCOL.md`
   * for the wire format.
   */
  ipcStdio: boolean;
  /**
   * Standalone MCP setup/config command. Runs and exits before agent startup.
   */
  mcpSetupCommand?: MCPSetupCommand;
}

function setMCPSetupCommand(config: CliConfig, command: MCPSetupCommand): void {
  if (config.mcpSetupCommand) {
    console.error("Only one MCP setup option can be used per invocation");
    process.exit(1);
  }
  config.mcpSetupCommand = command;
}

function printUsage(): void {
  const defaults: CliConfig = parseCliArgs(["--help-noop"]); // grab defaults
  console.log(`
Usage: npx hyperagent [OPTIONS]

Launch the Hyperlight Copilot SDK Agent — an interactive AI agent
with a sandboxed JavaScript executor.

Options:
  --model <name>         LLM model (default: ${defaults.model})
  --cpu-timeout <ms>     CPU time limit per execution (default: ${defaults.cpuTimeout})
  --wall-timeout <ms>    Wall-clock backstop (default: ${defaults.wallTimeout})
  --send-timeout <ms>    Agent send-and-wait timeout (default: ${defaults.sendTimeout})
  --heap-size <MB>       Guest heap size (default: ${defaults.heapSize})
  --scratch-size <MB>     Guest scratch size (default: ${defaults.scratchSize})
  --show-code            Log generated JS to ~/.hyperagent/logs/
  --show-timing          Log timing breakdown to ~/.hyperagent/logs/
  --reasoning-effort [level] Set reasoning effort (low|medium|high|xhigh, default: high)
                         Env: HYPERAGENT_REASONING_EFFORT
  --verbose              Stream reasoning + show sandbox tool result bodies
  --very-verbose, -vv    Like --verbose, plus show full bodies for ALL tools
                         (including plugin_info, module_info, register_handler, etc.)
                         Env: HYPERAGENT_VERY_VERBOSE
  --[no-]markdown        Toggle markdown rendering (default: on, env: HYPERAGENT_MARKDOWN)
                         Aliases: --md, --no-md
  --transcript           Record session transcript to ~/.hyperagent/logs/
  --list-models          List available models and exit
  --resume [id]          Resume previous session (last if no ID given)
  --plugins-dir <path>   Custom plugins directory (default: ./plugins)
  --debug                Enable debug logging to ~/.hyperagent/logs/
  --tune                 Capture LLM decision/reasoning logs to ~/.hyperagent/logs/
  --profile <name>       Apply resource profile at startup (limits only)
                         Stack: --profile "web-research heavy-compute"
                         Profiles: default, file-builder, web-research, heavy-compute, mcp-network
  --auto-approve, --yolo Auto-approve all interactive prompts (YOLO mode)
  --base-dir <path>      Base dir for fs-read + fs-write (auto-enables both plugins,
                         created if missing, symlinks rejected)
                         Env: HYPERAGENT_BASE_DIR
  --prompt "<text>"      Send a prompt non-interactively and exit after completion
  --prompt-file <path>   Read prompt from a file (avoids shell quoting issues)
  --skill <name>         Invoke skill(s) before the prompt (e.g. --skill pptx-expert)
  --output-threshold <bytes>  Large output threshold (default: 20480 = 20KB)
  --no-color             Strip ANSI colour codes from terminal output
  --quiet                Suppress informational notifications
  --attach <file>        Attach a file to the first user message (repeatable)
  --ipc-stdio            Headless mode: speak NDJSON on stdio (for embedding)
  --version, -v        Show version and exit
  --help, -h           Show this help message

Standalone MCP setup commands (run and exit):
  --mcp-setup-everything       Configure the MCP everything test server
  --mcp-setup-github           Configure the GitHub MCP server (uses GITHUB_TOKEN)
  --mcp-setup-filesystem [dir] Configure the filesystem MCP server (default: /tmp/mcp-fs)
  --mcp-show-config            Show configured MCP servers
  --mcp-setup-workiq           Configure Microsoft Work IQ stdio MCP server
  --mcp-setup-fabric-rti [args...]  Configure Fabric RTI (Kusto/KQL) MCP server
  --mcp-add-http <name> <url> [clientId] [tenantId] [scopes] [flow]
                               Add a generic HTTP MCP server
  --mcp-m365-create-app [args...]  Create/reuse Entra app for M365 HTTP MCP
  --mcp-setup-m365 [args...]       Configure Agent 365 HTTP MCP services
  --mcp-m365-refresh-servers [args...] Refresh the M365 MCP server catalog
  --mcp-m365-show              Show saved M365 app registration details

Plugin commands (at the REPL prompt):
  /plugins               List discovered plugins
  /enable <name>         Audit, configure, and enable a plugin
  /disable <name>        Disable an enabled plugin
  /audit <name>          Force re-audit a plugin

Environment variables (overridden by CLI flags):
  COPILOT_MODEL              Model name
  HYPERLIGHT_CPU_TIMEOUT_MS  CPU time limit (ms)
  HYPERLIGHT_WALL_TIMEOUT_MS Wall-clock limit (ms)
  HYPERAGENT_SEND_TIMEOUT_MS Agent send-and-wait timeout (ms)
  HYPERLIGHT_HEAP_SIZE_MB    Heap size (megabytes)
  HYPERLIGHT_SCRATCH_SIZE_MB   Scratch size (megabytes)
  HYPERAGENT_DEBUG           Set to '1' for debug logging
  HYPERAGENT_REASONING_EFFORT Reasoning effort level (low/medium/high/xhigh)
  HYPERAGENT_VERBOSE         Set to '1' for verbose output mode
  HYPERAGENT_VERY_VERBOSE    Set to '1' for very-verbose output (all tool bodies)
  HYPERAGENT_BASE_DIR        Base dir for fs-read + fs-write plugins
  HYPERAGENT_PROFILE         Profile name(s) to apply at startup
  HYPERAGENT_PROMPT          Non-interactive prompt text
  HYPERAGENT_PROMPT_FILE     Path to file containing prompt text
  HYPERAGENT_SKILL           Skill name(s) to invoke before the prompt
  HYPERAGENT_OUTPUT_THRESHOLD_BYTES  Large output threshold (bytes)
  HYPERAGENT_NO_COLOR        Set to '1' to strip ANSI colour codes
  HYPERAGENT_QUIET           Set to '1' to suppress informational notifications
`);
  process.exit(0);
}

/**
 * Parse CLI arguments (process.argv) into a typed config object.
 * CLI flags override environment variables, which override defaults.
 *
 * @param argv — Argument array (default: process.argv.slice(2))
 * @returns Parsed CLI config
 */
export function parseCliArgs(
  argv: string[] = process.argv.slice(2),
): CliConfig {
  const config: CliConfig = {
    model: process.env.COPILOT_MODEL || "claude-opus-4.6",
    cpuTimeout: process.env.HYPERLIGHT_CPU_TIMEOUT_MS || "1000",
    wallTimeout: process.env.HYPERLIGHT_WALL_TIMEOUT_MS || "5000",
    sendTimeout: process.env.HYPERAGENT_SEND_TIMEOUT_MS || "300000",
    heapSize: process.env.HYPERLIGHT_HEAP_SIZE_MB || "16",
    scratchSize: process.env.HYPERLIGHT_SCRATCH_SIZE_MB || "16",
    showCode: false,
    showTiming: false,
    reasoningEffort: normaliseReasoningEffort(
      process.env.HYPERAGENT_REASONING_EFFORT,
    ),
    // HYPERAGENT_VERY_VERBOSE implies HYPERAGENT_VERBOSE — keeps the env-var
    // path symmetric with the CLI flag (--very-verbose implies --verbose).
    // Without this, env-var-only --very-verbose would set `veryVerbose=true`
    // but `verbose=false`, and the event-handler gate (`verboseOutput && ...`)
    // would silently suppress all tool bodies.
    verbose:
      process.env.HYPERAGENT_VERBOSE === "1" ||
      process.env.HYPERAGENT_VERY_VERBOSE === "1",
    veryVerbose: process.env.HYPERAGENT_VERY_VERBOSE === "1",
    markdown: process.env.HYPERAGENT_MARKDOWN !== "0",
    transcript: process.env.HYPERAGENT_TRANSCRIPT === "1",
    listModels: process.env.HYPERAGENT_LIST_MODELS === "1",
    resumeSession: process.env.HYPERAGENT_RESUME_SESSION || "",
    pluginsDir: process.env.HYPERAGENT_PLUGINS_DIR || "",
    debug: process.env.HYPERAGENT_DEBUG === "1",
    tune: process.env.HYPERAGENT_TUNE === "1",
    profile: process.env.HYPERAGENT_PROFILE || "",
    autoApprove: process.env.HYPERAGENT_AUTO_APPROVE === "1",
    baseDir: normaliseBaseDir(process.env.HYPERAGENT_BASE_DIR),
    prompt: process.env.HYPERAGENT_PROMPT || "",
    promptFile: process.env.HYPERAGENT_PROMPT_FILE || "",
    skill: process.env.HYPERAGENT_SKILL || "",
    skipSuggest: process.env.HYPERAGENT_SKIP_SUGGEST === "1",
    outputThreshold: process.env.HYPERAGENT_OUTPUT_THRESHOLD_BYTES || "20480",
    showVersion: false,
    noColor: process.env.HYPERAGENT_NO_COLOR === "1",
    quiet: process.env.HYPERAGENT_QUIET === "1",
    attach: [],
    ipcStdio: process.env.HYPERAGENT_IPC_STDIO === "1",
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--model":
        config.model = argv[++i] ?? "";
        if (!config.model) {
          console.error("--model requires a value");
          process.exit(1);
        }
        break;
      case "--cpu-timeout":
        config.cpuTimeout = argv[++i] ?? "";
        if (!config.cpuTimeout) {
          console.error("--cpu-timeout requires a value");
          process.exit(1);
        }
        break;
      case "--wall-timeout":
        config.wallTimeout = argv[++i] ?? "";
        if (!config.wallTimeout) {
          console.error("--wall-timeout requires a value");
          process.exit(1);
        }
        break;
      case "--send-timeout":
        config.sendTimeout = argv[++i] ?? "";
        if (!config.sendTimeout) {
          console.error("--send-timeout requires a value");
          process.exit(1);
        }
        break;
      case "--heap-size":
        config.heapSize = argv[++i] ?? "";
        if (!config.heapSize) {
          console.error("--heap-size requires a value");
          process.exit(1);
        }
        break;
      case "--scratch-size":
        config.scratchSize = argv[++i] ?? "";
        if (!config.scratchSize) {
          console.error("--scratch-size requires a value");
          process.exit(1);
        }
        break;
      case "--show-code":
        config.showCode = true;
        break;
      case "--show-timing":
        config.showTiming = true;
        break;
      case "--reasoning-effort": {
        // --reasoning-effort can optionally take an effort level argument
        const nextArg = argv[i + 1];
        if (
          nextArg &&
          (VALID_REASONING_EFFORTS as readonly string[]).includes(
            nextArg.toLowerCase(),
          )
        ) {
          config.reasoningEffort = nextArg.toLowerCase();
          i++;
        } else {
          // No argument or invalid → default to "high"
          config.reasoningEffort = "high";
        }
        break;
      }
      case "--verbose":
        config.verbose = true;
        break;
      case "--very-verbose":
      case "-vv":
        // --very-verbose implies --verbose: standalone -vv enables both.
        // Plain --verbose without --very-verbose only shows full bodies for
        // sandbox tools (execute_javascript / execute_bash).
        config.verbose = true;
        config.veryVerbose = true;
        break;
      case "--no-markdown":
      case "--no-md":
        config.markdown = false;
        break;
      case "--markdown":
      case "--md":
        config.markdown = true;
        break;
      case "--transcript":
        config.transcript = true;
        break;
      case "--list-models":
        config.listModels = true;
        break;
      case "--resume": {
        // --resume can optionally take a session ID argument
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          config.resumeSession = next;
          i++;
        } else {
          config.resumeSession = "__last__";
        }
        break;
      }
      case "--plugins-dir":
        config.pluginsDir = argv[++i] ?? "";
        if (!config.pluginsDir) {
          console.error("--plugins-dir requires a value");
          process.exit(1);
        }
        break;
      case "--debug":
        config.debug = true;
        break;
      case "--tune":
        config.tune = true;
        break;
      case "--profile":
        config.profile = argv[++i] ?? "";
        if (!config.profile) {
          console.error("--profile requires a value");
          process.exit(1);
        }
        break;
      case "--auto-approve":
      case "--yolo":
        config.autoApprove = true;
        break;
      case "--base-dir": {
        // Trim at parse-time: --base-dir "   " should be rejected, not
        // silently resolved to process.cwd() later via resolve("").
        const raw = argv[++i] ?? "";
        const trimmed = raw.trim();
        if (!trimmed) {
          console.error("--base-dir requires a non-empty path");
          process.exit(1);
        }
        config.baseDir = trimmed;
        break;
      }
      case "--prompt":
        config.prompt = argv[++i] ?? "";
        if (!config.prompt) {
          console.error("--prompt requires a value");
          process.exit(1);
        }
        break;
      case "--prompt-file":
        config.promptFile = argv[++i] ?? "";
        if (!config.promptFile) {
          console.error("--prompt-file requires a value");
          process.exit(1);
        }
        break;
      case "--skill":
        config.skill = argv[++i] ?? "";
        if (!config.skill) {
          console.error("--skill requires a value");
          process.exit(1);
        }
        break;
      case "--skip-suggest":
        config.skipSuggest = true;
        break;
      case "--output-threshold":
        config.outputThreshold = argv[++i] ?? "";
        if (!config.outputThreshold) {
          console.error("--output-threshold requires a value");
          process.exit(1);
        }
        break;
      case "--version":
      case "-v":
        config.showVersion = true;
        break;
      case "--no-color":
      case "--no-colour":
        config.noColor = true;
        break;
      case "--quiet":
        config.quiet = true;
        break;
      case "--attach": {
        const path = argv[++i] ?? "";
        if (!path) {
          console.error("--attach requires a file path");
          process.exit(1);
        }
        config.attach.push(path);
        break;
      }
      case "--ipc-stdio":
        config.ipcStdio = true;
        break;
      case "--mcp-setup-everything":
        setMCPSetupCommand(config, { kind: "setup-everything" });
        break;
      case "--mcp-setup-github":
        setMCPSetupCommand(config, { kind: "setup-github" });
        break;
      case "--mcp-setup-filesystem": {
        const next = argv[i + 1];
        const dir = next && !next.startsWith("--") ? next : "/tmp/mcp-fs";
        if (dir === next) i++;
        setMCPSetupCommand(config, { kind: "setup-filesystem", dir });
        break;
      }
      case "--mcp-show-config":
        setMCPSetupCommand(config, { kind: "show-config" });
        break;
      case "--mcp-setup-workiq":
        setMCPSetupCommand(config, { kind: "setup-workiq" });
        break;
      case "--mcp-setup-fabric-rti":
        setMCPSetupCommand(config, {
          kind: "setup-fabric-rti",
          args: argv.slice(i + 1),
        });
        i = argv.length;
        break;
      case "--mcp-add-http":
        setMCPSetupCommand(config, {
          kind: "add-http",
          args: argv.slice(i + 1),
        });
        i = argv.length;
        break;
      case "--mcp-m365-create-app":
        setMCPSetupCommand(config, {
          kind: "m365-create-app",
          args: argv.slice(i + 1),
        });
        i = argv.length;
        break;
      case "--mcp-setup-m365":
        setMCPSetupCommand(config, {
          kind: "m365-setup",
          args: argv.slice(i + 1),
        });
        i = argv.length;
        break;
      case "--mcp-m365-refresh-servers":
        setMCPSetupCommand(config, {
          kind: "m365-refresh-servers",
          args: argv.slice(i + 1),
        });
        i = argv.length;
        break;
      case "--mcp-m365-show":
        setMCPSetupCommand(config, { kind: "m365-show" });
        break;
      case "--help":
      case "-h":
        printUsage();
        break;
      default:
        if (arg !== "--help-noop") {
          console.error(`Unknown option: ${arg} (use --help for usage)`);
          process.exit(1);
        }
    }
    i++;
  }

  // Resolve --prompt-file: read prompt from file if --prompt wasn't given directly.
  // CLI --prompt always wins over --prompt-file.
  if (!config.prompt && config.promptFile) {
    try {
      config.prompt = readFileSync(config.promptFile, "utf-8").trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to read prompt file "${config.promptFile}": ${msg}`,
      );
      process.exit(1);
    }
  }

  // --ipc-stdio is mutually exclusive with the one-shot --prompt path.
  // The host can drive the agent by sending `user-input` frames on
  // stdin instead — combining them would silently ignore the prompt.
  if (config.ipcStdio && config.prompt) {
    console.error(
      "--ipc-stdio cannot be combined with --prompt/--prompt-file (send a user-input frame on stdin instead)",
    );
    process.exit(1);
  }

  return config;
}

/**
 * Propagate CLI flags into the environment so downstream modules
 * (`sandbox-tool.js`, the Copilot SDK, the MCP client manager, etc.)
 * pick them up without having to thread `cli` through every import.
 *
 * Behaviour is exhaustive and deterministic: every always-on
 * mapping fires unconditionally; the verbose/debug flags set their
 * env mirror only when truthy (so a clean shell doesn't have a
 * stray `HYPERAGENT_VERBOSE=` lingering from a previous run).
 *
 * Extracted from `index.ts`'s top-level setup so it can be unit
 * tested directly — without spawning the agent — and so the
 * behaviour stays in one place rather than two scattered blocks.
 *
 * @param cli - Parsed CLI config (typically from `parseCliArgs()`).
 * @param env - Target environment object. Defaults to `process.env`;
 *   tests pass a throwaway record to assert on the writes without
 *   leaking into the real process environment.
 */
export function applyCliEnvOverrides(
  cli: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Always-on numeric / string propagation. Sandbox-tool.js and the
  // Copilot SDK read these env vars at boot.
  env.COPILOT_MODEL = cli.model;
  env.HYPERLIGHT_CPU_TIMEOUT_MS = cli.cpuTimeout;
  env.HYPERLIGHT_WALL_TIMEOUT_MS = cli.wallTimeout;
  env.HYPERAGENT_SEND_TIMEOUT_MS = cli.sendTimeout;
  env.HYPERLIGHT_HEAP_SIZE_MB = cli.heapSize;
  env.HYPERLIGHT_SCRATCH_SIZE_MB = cli.scratchSize;

  // Large-output threshold mirrored to all three env names the SDK
  // and our own tool handler look at. Keeping them in sync at boot
  // guarantees the SDK's fallback path uses the same value we do.
  env.HYPERAGENT_OUTPUT_THRESHOLD_BYTES = cli.outputThreshold;
  env.COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES = cli.outputThreshold;
  env.COPILOT_LARGE_OUTPUT_MAX_BYTES = cli.outputThreshold;

  // Conditional flags — set only when truthy so a downstream env-var
  // check like `process.env.HYPERAGENT_VERBOSE === "1"` doesn't see
  // a stale "0" or empty string from a previous run.
  if (cli.verbose) env.HYPERAGENT_VERBOSE = "1";
  if (cli.veryVerbose) env.HYPERAGENT_VERY_VERBOSE = "1";
  if (cli.debug) env.HYPERAGENT_DEBUG = "1";
}
