# ── HyperAgent Justfile ───────────────────────────────────────────────
#
# Build, test, lint, and run the HyperAgent standalone project.
#
# Prerequisites:
#   - Node.js >= 18
#   - npm
#   - Rust toolchain (for building the native hyperlight-js addon)
#   - KVM support (for running the Hyperlight micro-VM)
#
# First-time setup:
#   just setup       # clones + builds hyperlight-js, installs npm deps
#
# ─────────────────────────────────────────────────────────────────────

# Windows: use PowerShell, replace backslashes for clang compatibility
set windows-shell := ["pwsh.exe", "-NoLogo", "-Command"]

# In windows we need to replace the backslashes with forward slashes
# otherwise clang will misinterpret the paths
PWD := replace(justfile_dir(), "\\", "/")

# On Windows, use Ninja generator for CMake to avoid aws-lc-sys build issues
export CMAKE_GENERATOR := if os() == "windows" { "Ninja" } else { "" }

# The hyperlight-js repo URL and ref to build against.
# Currently using Simon's fork with in-flight PRs (binary types, call stats).
# TODO: Switch to hyperlight-dev/hyperlight-js main once PRs land upstream.
hyperlight-repo   := "https://github.com/simongdavies/hyperlight-js.git"
hyperlight-ref    := "hyperagent"
hyperlight-dir    := justfile_dir() / "deps" / "hyperlight-js"

# Hyperlight analysis guest (secure code validation in micro-VM)
analysis-guest-dir := justfile_dir() / "src" / "code-validator" / "guest"

# HyperAgent custom runtime (native Rust modules for the sandbox)
runtime-dir := justfile_dir() / "src" / "sandbox" / "runtime"

# HYPERLIGHT_CFLAGS needed for building guests that link rquickjs/QuickJS:
# -I include/ provides stubs for the hyperlight target (no libc)
# -D__wasi__=1 disables pthread support in QuickJS
# Uses forward slashes (PWD) so clang works on Windows
runtime-cflags := "-I" + PWD + "/deps/hyperlight-js/src/hyperlight-js-runtime/include -D__wasi__=1"

# Export HYPERLIGHT_CFLAGS so cargo-hyperlight picks them up when building runtimes
export HYPERLIGHT_CFLAGS := runtime-cflags

# Custom runtime binary path — exported so hyperlight-js build.rs embeds it.
# This ensures ALL builds (setup, build, npm install) use the native module runtime.
# Without this, the default runtime (no ha:ziplib) would be embedded.
export HYPERLIGHT_JS_RUNTIME_PATH := runtime-dir / "target" / "x86_64-hyperlight-none" / "release" / "hyperagent-runtime"

# Clone (or update) the hyperlight-js dependency at the pinned ref.
# Cross-platform: - prefix ignores clone failure (dir already exists).
[private]
fetch-hyperlight:
    -git clone --branch "{{hyperlight-ref}}" --single-branch --depth 1 "{{hyperlight-repo}}" "{{hyperlight-dir}}"
    cd "{{hyperlight-dir}}" && git fetch origin "{{hyperlight-ref}}" --depth 1 && git checkout FETCH_HEAD

# Install required Rust toolchains and cargo subcommands.
# Cross-platform (Linux/macOS/Windows) — no bash required.
[private]
ensure-tools:
    cargo install cargo-hyperlight --locked --version 0.1.7
    rustup toolchain install 1.89 --no-self-update
    rustup toolchain install nightly --no-self-update

# Build the native hyperlight-js NAPI addon (debug — default)
# Depends on build-runtime-release so the custom runtime with native modules
# is always embedded. cargo clean -p prevents stale cached builds.
[private]
build-hyperlight: fetch-hyperlight (build-runtime-release)
    -cd "{{hyperlight-dir}}/src/hyperlight-js" && cargo clean -p hyperlight-js
    cd "{{hyperlight-dir}}" && just build

# Build the native hyperlight-js NAPI addon (release — optimised)
[private]
build-hyperlight-release: fetch-hyperlight (build-runtime-release)
    -cd "{{hyperlight-dir}}/src/hyperlight-js" && cargo clean -p hyperlight-js
    cd "{{hyperlight-dir}}" && just build release

# Build the hyperlight-analysis-guest NAPI addon (debug)
[private]
build-analysis-guest:
    cd "{{analysis-guest-dir}}" && just build debug && just build-napi debug

# Build the hyperlight-analysis-guest NAPI addon (release)
[private]
build-analysis-guest-release:
    cd "{{analysis-guest-dir}}" && just build release && just build-napi release

# Install npm deps (links hyperlight-js and analysis-guest from local dirs)
[private]
install: build-hyperlight build-analysis-guest
    npm install

# Install npm deps with release-built native addons
[private]
install-release: build-hyperlight-release build-analysis-guest-release
    npm install

# ── First-time setup ─────────────────────────────────────────────────

# Clone hyperlight-js, build native addon, install npm deps
setup: ensure-tools install
    @echo "✅ Setup complete — run 'just start' to launch the agent"

# ── Development ──────────────────────────────────────────────────────

# Build/rebuild the native hyperlight-js addon and install deps
build: install
    @echo "✅ Build complete — run 'just start' to launch the agent"

# Build everything in release mode (hyperlight-js, guest runtime, NAPI addon)
build-release: install-release
    @echo "✅ Release build complete — run 'just start-release' to launch"

# ── Standalone Binary ───────────────────────────────────────────────────

# Build standalone hyperagent binary (debug mode)
# After build: dist/bin/hyperagent or add dist/bin to PATH
binary: install
    node scripts/build-binary.js
    @echo "💡 Run: dist/bin/hyperagent  OR  export PATH=\"$PWD/dist/bin:\$PATH\" && hyperagent"

# Build standalone hyperagent binary (release mode — minified, no sourcemaps)
binary-release: install-release
    node scripts/build-binary.js --release
    @echo "💡 Run: dist/bin/hyperagent  OR  export PATH=\"$PWD/dist/bin:\$PATH\" && hyperagent"

# Run the standalone binary (builds first if needed)
run *ARGS: binary
    dist/bin/hyperagent {{ARGS}}

# Run the standalone release binary (builds first if needed)
run-release *ARGS: binary-release
    dist/bin/hyperagent {{ARGS}}

# ────────────────────────────────────────────────────────────────────────

# Run the agent (tsx transpiles on the fly — no build step needed)
start *ARGS: install
    npx tsx src/agent/index.ts {{ARGS}}

# Run with crash diagnostics (generates crash report .json files on SIGSEGV)
start-debug *ARGS: install
    NODE_OPTIONS="--report-on-signal --report-on-fatalerror --report-directory=$HOME/.hyperagent/logs" npx tsx src/agent/index.ts {{ARGS}}

# Run the agent with release-built native addon (faster sandbox execution)
start-release *ARGS: install-release
    npx tsx src/agent/index.ts {{ARGS}}

# Run tests
test: install
    npm test

# Type-check (must be zero errors — no excuses)
typecheck: install
    npm run typecheck

# Format code
fmt: install
    npm run fmt

# Check formatting
fmt-check: install
    npm run fmt:check

# Lint: format check + type check (no tests — fast feedback)
lint: fmt-check typecheck
    @echo "✅ Lint passed — looking sharp"

# Lint Rust code in analysis-guest
lint-rust:
    cd "{{analysis-guest-dir}}" && cargo fmt --check && cargo clippy --workspace -- -D warnings
    @echo "✅ Rust lint passed"

# Format Rust code in analysis-guest
fmt-rust:
    cd "{{analysis-guest-dir}}" && cargo fmt

# Test Rust code in analysis-guest
# Note: --test-threads=1 required because QuickJS context isn't thread-safe
test-rust:
    cd "{{analysis-guest-dir}}" && cargo test --workspace -- --test-threads=1

# ── HyperAgent Runtime (native modules) ──────────────────────────────

# Build the custom runtime for the hyperlight target (debug)
build-runtime: fetch-hyperlight
    cd "{{runtime-dir}}" && cargo +1.89 hyperlight build --target-dir target

# Build the custom runtime for the hyperlight target (release)
build-runtime-release: fetch-hyperlight
    cd "{{runtime-dir}}" && cargo +1.89 hyperlight build --target-dir target --release

# Legacy alias — the standard build now always uses the custom runtime.
# Kept for backwards compatibility with existing scripts/docs.
build-with-runtime: build
    @echo "✅ (build-with-runtime is now a no-op — 'just build' always uses the custom runtime)"

# Lint Rust code in the custom runtime
lint-runtime:
    cd "{{runtime-dir}}" && cargo +1.89 clippy --workspace -- -D warnings
    cd "{{runtime-dir}}" && cargo +1.89 fmt --check
    @echo "✅ Runtime lint passed"

# Format Rust code in the custom runtime
fmt-runtime:
    cd "{{runtime-dir}}" && cargo +1.89 fmt --all

# Full lint: TypeScript + Rust (analysis-guest + runtime)
lint-all: lint lint-rust lint-runtime
    @echo "✅ All lints passed"

# Full format: TypeScript + Rust
fmt-all: fmt fmt-rust fmt-runtime
    @echo "✅ All code formatted"

# Full test: TypeScript + Rust
test-all: test test-rust
    @echo "✅ All tests passed"

# ── OOXML Validation ─────────────────────────────────────────────────

# Validate a PPTX file against the OpenXML SDK schema.
# Uses @xarsh/ooxml-validator (bundled native binary — no dotnet needed).
validate-pptx FILE:
    npx ooxml-validator {{FILE}}

# ── Quality Gate ─────────────────────────────────────────────────────

# Run ALL checks: format, types, tests (TS + Rust)
check: lint-all test-all
    @echo "✅ All checks passed — you may proceed to commit"

# Clean build artifacts (keeps deps/)
clean:
    rm -rf dist node_modules

# Clean everything including the hyperlight-js clone
clean-all: clean
    rm -rf deps

# ── Docker ───────────────────────────────────────────────────────────

# Build the Docker image (version calculated using MinVer rules from git tags)
docker-build:
    #!/usr/bin/env bash
    set -euo pipefail
    # Calculate MinVer-style version from git tags
    describe=$(git describe --tags --long --always --dirty 2>/dev/null || echo "unknown")
    if [[ "$describe" =~ ^v?([0-9]+\.[0-9]+\.[0-9]+)-([0-9]+)-g([a-f0-9]+)(-dirty)?$ ]]; then
        tag="${BASH_REMATCH[1]}"
        height="${BASH_REMATCH[2]}"
        commit="${BASH_REMATCH[3]}"
        dirty="${BASH_REMATCH[4]}"
        if [ "$height" = "0" ]; then
            version="${tag}${dirty:++dirty}"
        else
            IFS='.' read -r major minor patch <<< "$tag"
            version="${major}.${minor}.$((patch + 1))-alpha.${height}+${commit}${dirty:+.dirty}"
        fi
    elif [[ "$describe" =~ ^v?([0-9]+\.[0-9]+\.[0-9]+)(-dirty)?$ ]]; then
        version="${BASH_REMATCH[1]}${BASH_REMATCH[2]:++dirty}"
    elif [[ "$describe" =~ ^[a-f0-9]+(-dirty)?$ ]]; then
        count=$(git rev-list --count HEAD 2>/dev/null || echo "0")
        commit="${describe%-dirty}"
        version="0.0.0-alpha.${count}+${commit}${BASH_REMATCH[1]:+.dirty}"
    else
        version="0.0.0-dev"
    fi
    echo "📦 Docker build version: ${version}"
    docker build -t hyperagent --build-arg VERSION="${version}" .

# Run hyperagent in Docker (requires /dev/kvm or /dev/mshv)
docker-run *ARGS:
    ./scripts/hyperagent-docker {{ARGS}}
