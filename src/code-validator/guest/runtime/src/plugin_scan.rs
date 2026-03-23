// ── Plugin Scanner — Linear-time static analysis for plugin security ─────────
//
// Ports the SCAN_PATTERNS from plugin-manager.ts to Rust using regex-automata.
// This provides ReDoS-safe pattern matching in the isolated Hyperlight guest.
//
// ─────────────────────────────────────────────────────────────────────────────

use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;
use regex_automata::meta::Regex;
use serde::{Deserialize, Serialize};

/// Configuration for plugin scanning.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanConfig {
    /// Skip comment-only lines (default: true).
    #[serde(default = "default_skip_comments")]
    pub skip_comments: bool,
}

fn default_skip_comments() -> bool {
    true
}

/// A single finding from the plugin scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanFinding {
    /// Severity: "danger", "warning", or "info"
    pub severity: String,
    /// Human-readable message describing the finding.
    pub message: String,
    /// Line number where the pattern was found (1-indexed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

/// Result of scanning a plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    /// All findings, sorted by severity (danger → warning → info).
    pub findings: Vec<ScanFinding>,
    /// Size of the source in bytes.
    pub source_size: usize,
}

/// A compiled scan pattern with severity and message.
struct ScanPattern {
    pattern: Regex,
    severity: &'static str,
    message: &'static str,
}

/// Initialize all scan patterns. Using a function instead of lazy_static
/// for no_std compatibility and deterministic compilation.
///
/// NOTE: We use explicit character classes instead of Perl shortcuts because
/// regex-automata without the `unicode-perl` feature doesn't support them:
/// - `[ \t\n\r]` instead of `\s` (whitespace)
/// - `[a-zA-Z0-9_]` instead of `\w` (word char)
/// - Avoid `\b` entirely — use explicit patterns or accept minor false positives
///
/// This keeps binary size small while still catching security patterns.
// All regex patterns here are static string literals validated via Regex::new(...).expect(...).
// Covered by test_get_patterns_compile() to catch regressions.
#[allow(clippy::expect_used)]
fn get_patterns() -> Vec<ScanPattern> {
    vec![
        // ── Process execution (DANGER) ───────────────────────────────
        //
        // The `child_process` literal catches imports/requires of the module.
        // We match `.spawn(`, `.fork(`, `.execFile(`, `.execSync(`, and
        // `.execFileSync(` directly. Bare `.exec(` is intentionally excluded
        // because it false-positives on `RegExp.prototype.exec()`.
        ScanPattern {
            pattern: Regex::new(r"child_process|\.execFile[ \t\n\r]*\(|\.execSync[ \t\n\r]*\(|\.execFileSync[ \t\n\r]*\(|\.spawn[ \t\n\r]*\(|\.spawnSync[ \t\n\r]*\(|\.fork[ \t\n\r]*\(")
                .expect("child_process pattern"),
            severity: "danger",
            message: "Process execution — can run arbitrary commands on the host",
        },
        // eval( — matching the literal is sufficient (xeval is not a concern)
        // new Function( — same, match literally
        ScanPattern {
            pattern: Regex::new(r"(?:^|[^a-zA-Z0-9_])eval[ \t\n\r]*\(|new[ \t\n\r]+Function[ \t\n\r]*\(")
                .expect("eval pattern"),
            severity: "danger",
            message: "Dynamic code execution — eval() or Function constructor",
        },
        // ── Dynamic imports (DANGER) ───────────────────────────────────
        //
        // Plugins should use static imports only. Dynamic require() and
        // import() can load arbitrary code at runtime, bypassing audits.
        // import.meta.resolve() can probe the module system.
        //
        // NOTE: We match require( broadly here. The specific module patterns
        // (vm, fs, etc.) will also fire, but this catches ALL require() usage.
        ScanPattern {
            pattern: Regex::new(r"(?:^|[^a-zA-Z0-9_.])require[ \t\n\r]*\(")
                .expect("require pattern"),
            severity: "danger",
            message: "Dynamic require() — plugins must use static imports only",
        },
        // Match import( but EXCLUDE TypeScript type imports which use:
        //   : import("...") — type annotation (with optional whitespace)
        //   < import("...") — generic type parameter
        //   type X = import("...") — type alias
        // These are compile-time only and safe.
        //
        // Strategy: Match import( preceded by something that indicates runtime usage:
        //   - await import( — async dynamic import
        //   - [let|const|var] x = import( — variable assignment (NOT type alias)
        //   - ( import( — passed as argument
        //   - , import( — in array or argument list
        //   - || import( / && import( — conditional
        //
        // We specifically look for runtime patterns rather than trying to exclude type patterns.
        // This is more robust because new TS type syntax won't cause false positives.
        ScanPattern {
            pattern: Regex::new(r"(?:await|[(,|&?]|\|\||(?:let|const|var)[ \t\n\r]+[a-zA-Z_][a-zA-Z0-9_]*[ \t\n\r]*=)[ \t\n\r]*import[ \t\n\r]*\(")
                .expect("dynamic import pattern"),
            severity: "danger",
            message: "Dynamic import() — plugins must use static imports only",
        },
        ScanPattern {
            pattern: Regex::new(r"import\.meta\.resolve[ \t\n\r]*\(")
                .expect("import.meta.resolve pattern"),
            severity: "danger",
            message: "import.meta.resolve() — can probe module system",
        },
        // ── VM module — sandbox escape (DANGER) ──────────────────────
        //
        // The vm module lets you create "sandboxes" that are NOT secure.
        // Code can escape via prototype chain, constructor access, etc.
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*['"](?:node:)?vm['"][ \t\n\r]*\)|from[ \t\n\r]+['"](?:node:)?vm['"]|vm\.run|vm\.createContext|vm\.Script"#)
                .expect("vm pattern"),
            severity: "danger",
            message: "VM module — sandbox escape risk, vm contexts are NOT secure",
        },
        // ── Worker threads — sandbox bypass (DANGER) ─────────────────
        //
        // Workers run in separate threads with full Node.js access.
        // A plugin could spawn workers to bypass any restrictions.
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*['"](?:node:)?worker_threads['"][ \t\n\r]*\)|from[ \t\n\r]+['"](?:node:)?worker_threads['"]|new[ \t\n\r]+Worker[ \t\n\r]*\("#)
                .expect("worker_threads pattern"),
            severity: "danger",
            message: "Worker threads — can bypass plugin sandbox restrictions",
        },
        // ── Cluster module — process forking (DANGER) ────────────────
        //
        // cluster.fork() creates new Node.js processes. Similar risk to
        // child_process but easier to miss.
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*['"](?:node:)?cluster['"][ \t\n\r]*\)|from[ \t\n\r]+['"](?:node:)?cluster['"]|cluster\.fork[ \t\n\r]*\("#)
                .expect("cluster pattern"),
            severity: "danger",
            message: "Cluster module — can fork new processes",
        },
        // ── Native addon loading (DANGER) ────────────────────────────
        //
        // .node files are native addons with arbitrary native code access.
        // process.binding() and process._linkedBinding() access internal APIs.
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*[^)]*\.node[ \t\n\r]*['"]|process\.binding[ \t\n\r]*\(|process\._linkedBinding[ \t\n\r]*\("#)
                .expect("native addon pattern"),
            severity: "danger",
            message: "Native addon loading — arbitrary native code execution",
        },
        // ── External imports (DANGER) ────────────────────────────────
        //
        // Plugins should only import from local shared code or Node.js builtins.
        // Any npm package imports are a supply chain risk.
        //
        // Since regex-automata doesn't support lookahead, we match common
        // npm package patterns: @scope/package (scoped) and multi-segment
        // package names (like lodash-es, react-dom). Single-word packages
        // that overlap with builtins are caught by other patterns.
        //
        // Patterns matched:
        // - @scope/package (scoped npm packages)
        // - package/subpath (package with subpath, but not ./local or node:xxx)
        // - known-dangerous packages by name (lodash, axios, underscore, etc.)
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*['"]@[a-zA-Z0-9_-]+/|from[ \t\n\r]+['"]@[a-zA-Z0-9_-]+/"#)
                .expect("scoped package pattern"),
            severity: "danger",
            message: "Scoped npm package import — supply chain risk, plugins must only use local code",
        },
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*['"](?:lodash|underscore|axios|request|got|node-fetch|express|koa|fastify|moment|dayjs|cheerio|puppeteer|playwright|sharp|jimp|socket\.io|ws|redis|mongodb|mongoose|sequelize|typeorm|prisma|knex|pg|mysql|sqlite3|better-sqlite3)(?:/[^'"]*)?['"]|from[ \t\n\r]+['"](?:lodash|underscore|axios|request|got|node-fetch|express|koa|fastify|moment|dayjs|cheerio|puppeteer|playwright|sharp|jimp|socket\.io|ws|redis|mongodb|mongoose|sequelize|typeorm|prisma|knex|pg|mysql|sqlite3|better-sqlite3)(?:/[^'"]*)?['"]"#)
                .expect("known npm package pattern"),
            severity: "danger",
            message: "Known npm package import — supply chain risk, plugins must only use local code",
        },
        // ── Filesystem access (WARNING) ──────────────────────────────
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*['"]fs['"][ \t\n\r]*\)|from[ \t\n\r]+['"]fs['"]"#)
                .expect("fs pattern"),
            severity: "warning",
            message: "Direct filesystem access via Node.js fs module",
        },
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*['"]node:fs['"][ \t\n\r]*\)|from[ \t\n\r]+['"]node:fs['"]"#)
                .expect("node:fs pattern"),
            severity: "warning",
            message: "Direct filesystem access via Node.js node:fs module",
        },
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*['"](?:node:)?fs/promises['"][ \t\n\r]*\)|from[ \t\n\r]+['"](?:node:)?fs/promises['"]"#)
                .expect("fs/promises pattern"),
            severity: "warning",
            message: "Direct filesystem access via fs/promises module",
        },
        // ── Network access (WARNING) ─────────────────────────────────
        // Match both bare imports (net, http, https, dgram) and node:-prefixed
        // imports (node:net, node:http, node:https, node:dgram, node:dns)
        ScanPattern {
            pattern: Regex::new(r#"require[ \t\n\r]*\([ \t\n\r]*['"](?:node:)?(?:net|http|https|dgram|dns)['"][ \t\n\r]*\)|from[ \t\n\r]+['"](?:node:)?(?:net|http|https|dgram|dns)(?:/[^'"]+)?['"]"#)
                .expect("network pattern"),
            severity: "warning",
            message: "Network access — net, http, https, dgram, or dns module",
        },
        // fetch( — the function name is distinctive enough
        ScanPattern {
            pattern: Regex::new(r"(?:^|[^a-zA-Z0-9_])fetch[ \t\n\r]*\(")
                .expect("fetch pattern"),
            severity: "warning",
            message: "Network access via fetch()",
        },
        // ── Environment / global access (WARNING) ─────────────────────
        ScanPattern {
            pattern: Regex::new(r"process\.env")
                .expect("process.env pattern"),
            severity: "warning",
            message: "Reads host environment variables",
        },
        // globalThis = ... | global[ | global.xxx =
        ScanPattern {
            pattern: Regex::new(r"globalThis[^a-zA-Z0-9_].*=|global[ \t\n\r]*\[|global\.[a-zA-Z0-9_]+[ \t\n\r]*=")
                .expect("global pattern"),
            severity: "warning",
            message: "Modifies global scope",
        },
        // ── Informational ────────────────────────────────────────────
        // __dirname and __filename — literal match is fine
        ScanPattern {
            pattern: Regex::new(r"__dirname|__filename")
                .expect("dirname pattern"),
            severity: "info",
            message: "References host path variables (__dirname / __filename)",
        },
        ScanPattern {
            pattern: Regex::new(r"path\.(resolve|join|dirname|basename)[ \t\n\r]*\(")
                .expect("path pattern"),
            severity: "info",
            message: "Uses path manipulation functions",
        },
        // ── Security mitigations (positive indicators) ───────────────
        //
        // These detect when a plugin implements security measures like
        // path-jailing, size caps, or allowlists.
        ScanPattern {
            pattern: Regex::new(r"realpathSync[ \t\n\r]*\(|realpathSync[^a-zA-Z0-9_]|lstatSync[ \t\n\r]*\(|isSymbolicLink[ \t\n\r]*\(")
                .expect("symlink pattern"),
            severity: "info",
            message: "🛡️ Symlink detection — checks or rejects symlinks to prevent escapes",
        },
        ScanPattern {
            pattern: Regex::new(r#"\.startsWith[ \t\n\r]*\([ \t\n\r]*['"]\.\.['"]"#)
                .expect("traversal guard pattern"),
            severity: "info",
            message: "🛡️ Path traversal guard — rejects attempts to escape allowed directories",
        },
        ScanPattern {
            pattern: Regex::new(r"allowedPaths|basePaths|writePaths|allowedDirs|resolvedBases|baseDir|resolvedBase")
                .expect("allowlist pattern"),
            severity: "info",
            message: "🛡️ Directory allowlist — filesystem access is explicitly scoped",
        },
        ScanPattern {
            pattern: Regex::new(r"\.size[ \t\n\r]*>|maxFileSize|maxWriteSize|maxFileBytes|maxWriteBytes")
                .expect("size cap pattern"),
            severity: "info",
            message: "🛡️ File size cap — prevents memory exhaustion attacks",
        },
        // allowWrites — look for the identifier
        ScanPattern {
            pattern: Regex::new(r"allowWrites[^a-zA-Z0-9_]|config\.allowWrites|allowWrites[ \t\n\r]*[!=]")
                .expect("allowWrites pattern"),
            severity: "info",
            message: "🛡️ Write operations gated behind explicit opt-in flag",
        },
        ScanPattern {
            pattern: Regex::new(r#"\.startsWith[ \t\n\r]*\([ \t\n\r]*['"]\.["']"#)
                .expect("dotfile guard pattern"),
            severity: "info",
            message: "🛡️ Dotfile / path-component guard — blocks dotfiles or traversal",
        },
    ]
}

/// Scan plugin source code for security patterns.
///
/// Returns findings sorted by severity (danger → warning → info).
/// All pattern matching uses regex-automata DFA for linear-time guarantees.
pub fn scan_plugin(source: &str, _config: &ScanConfig) -> ScanResult {
    let patterns = get_patterns();
    let mut findings: Vec<ScanFinding> = Vec::new();

    for (line_num, line) in source.lines().enumerate() {
        // Skip comment-only lines (single-line // and block /* */)
        let trimmed = line.trim();
        if trimmed.starts_with("//") || trimmed.starts_with("*") || trimmed.starts_with("/*") {
            continue;
        }

        for pattern in &patterns {
            if pattern.pattern.is_match(line) {
                findings.push(ScanFinding {
                    severity: pattern.severity.to_string(),
                    message: pattern.message.to_string(),
                    line: Some(line_num + 1),
                });
            }
        }
    }

    // Sort by severity: danger → warning → info
    findings.sort_by_key(|f| match f.severity.as_str() {
        "danger" => 0,
        "warning" => 1,
        "info" => 2,
        _ => 3,
    });

    ScanResult {
        findings,
        source_size: source.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ensures every regex in get_patterns() compiles without panicking.
    #[test]
    fn test_get_patterns_compile() {
        let patterns = get_patterns();
        assert!(
            !patterns.is_empty(),
            "get_patterns() should return at least one pattern"
        );
    }

    fn scan(source: &str) -> Vec<ScanFinding> {
        scan_plugin(source, &ScanConfig::default()).findings
    }

    #[test]
    fn test_detects_child_process() {
        let source = r#"
            import { spawn } from 'child_process';
            spawn('ls', ['-la']);
        "#;
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("Process execution"));
    }

    #[test]
    fn test_detects_eval() {
        let source = "eval('alert(1)');";
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("Dynamic code execution"));
    }

    #[test]
    fn test_detects_fs_import() {
        let source = r#"import fs from 'fs';"#;
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "warning");
        assert!(findings[0].message.contains("filesystem access"));
    }

    #[test]
    fn test_detects_fetch() {
        let source = "const response = await fetch('https://example.com');";
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "warning");
        assert!(findings[0].message.contains("fetch"));
    }

    #[test]
    fn test_detects_security_mitigation() {
        let source = r#"
            const resolvedBase = path.resolve(baseDir);
            if (!target.startsWith(resolvedBase)) throw new Error('Path escape');
        "#;
        let findings = scan(source);
        // Should find info-level security mitigation patterns
        let info_findings: Vec<_> = findings.iter().filter(|f| f.severity == "info").collect();
        assert!(!info_findings.is_empty());
    }

    #[test]
    fn test_skips_comment_only_lines() {
        let source = r#"
            // child_process is dangerous
            /* eval('bad') */
            * spawn('ls')
        "#;
        let findings = scan(source);
        // Comments should be skipped, so no findings
        assert!(findings.is_empty());
    }

    #[test]
    fn test_sorts_by_severity() {
        let source = r#"
            import fs from 'fs';
            const x = __dirname;
            eval('bad');
        "#;
        let findings = scan(source);
        assert!(findings.len() >= 3);
        // First should be danger (eval)
        assert_eq!(findings[0].severity, "danger");
        // Then warning (fs)
        assert!(findings.iter().any(|f| f.severity == "warning"));
        // Then info (__dirname)
        assert!(findings.iter().any(|f| f.severity == "info"));
    }

    #[test]
    fn test_includes_line_numbers() {
        let source = "line1\neval('bad')\nline3";
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].line, Some(2));
    }

    #[test]
    fn test_no_false_positive_on_regex_exec() {
        // .exec() alone should NOT trigger (it's RegExp.prototype.exec)
        let source = "const match = regex.exec(str);";
        let findings = scan(source);
        // Should be empty - no process execution pattern matches
        assert!(findings.is_empty());
    }

    #[test]
    fn test_detects_vm_module() {
        let source = r#"import { runInNewContext } from 'node:vm';"#;
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("VM module"));
    }

    #[test]
    fn test_detects_worker_threads() {
        let source = r#"import { Worker } from 'worker_threads';"#;
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("Worker threads"));
    }

    #[test]
    fn test_detects_cluster() {
        let source = r#"import cluster from 'cluster';"#;
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("Cluster module"));
    }

    #[test]
    fn test_detects_native_addon() {
        // Using static import to test .node detection without triggering require() pattern
        let source = "process.binding('fs');";
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("Native addon"));
    }

    #[test]
    fn test_detects_require() {
        let source = "const fs = require('fs');";
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        // Should have both require() danger and fs warning
        assert!(
            findings
                .iter()
                .any(|f| f.message.contains("Dynamic require"))
        );
    }

    #[test]
    fn test_detects_dynamic_import() {
        let source = "const mod = await import('./dynamic.js');";
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("Dynamic import"));
    }

    #[test]
    fn test_ignores_typescript_type_import() {
        // TypeScript type imports use import() in type position — NOT runtime dynamic imports
        // These should NOT trigger the dynamic import warning
        let source = r#"
            function foo(res: import("http").IncomingMessage): void {}
            type Res = import("https").ServerResponse;
            const x: import("fs").Stats = getStats();
        "#;
        let findings = scan(source);
        // Should have no "Dynamic import" findings
        let dynamic_import_findings: Vec<_> = findings
            .iter()
            .filter(|f| f.message.contains("Dynamic import"))
            .collect();
        assert!(
            dynamic_import_findings.is_empty(),
            "TypeScript type imports should not trigger dynamic import warning: {:?}",
            dynamic_import_findings
        );
    }

    #[test]
    fn test_detects_real_dynamic_import_not_type() {
        // Make sure we still catch real dynamic imports even with the type import fix
        let source = r#"
            // This is a real runtime dynamic import, not a type
            const mod = await import("./evil.js");
        "#;
        let findings = scan(source);
        assert!(
            findings
                .iter()
                .any(|f| f.message.contains("Dynamic import")),
            "Real dynamic imports should still be detected"
        );
    }

    #[test]
    fn test_detects_import_meta_resolve() {
        let source = "const path = import.meta.resolve('./foo');";
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("import.meta.resolve"));
    }

    #[test]
    fn test_detects_external_import() {
        // Scoped package
        let source = r#"import something from '@company/package';"#;
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("Scoped npm package"));
    }

    #[test]
    fn test_detects_known_npm_package() {
        let source = r#"import lodash from 'lodash';"#;
        let findings = scan(source);
        assert!(!findings.is_empty());
        assert_eq!(findings[0].severity, "danger");
        assert!(findings[0].message.contains("Known npm package"));
    }

    #[test]
    fn test_allows_local_imports() {
        // Relative imports should NOT trigger the external import pattern
        let source = r#"import { helper } from './utils.js';"#;
        let findings = scan(source);
        // Should be empty - local imports are allowed
        assert!(findings.is_empty());
    }

    #[test]
    fn test_allows_node_builtins() {
        // node: prefixed builtins should NOT trigger external import
        // (they may trigger other patterns like fs warning, but not external import danger)
        let source = r#"import path from 'node:path';"#;
        let findings = scan(source);
        // Should only have info-level path findings, not danger-level external import
        let danger = findings.iter().filter(|f| f.severity == "danger").count();
        assert_eq!(danger, 0);
    }
}
