#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# HyperAgent Gauntlet Test
# ═══════════════════════════════════════════════════════════════════
#
# Runs a comprehensive PPTX presentation generation through ALL
# launch modes: tsx (3 variants), binary (4 variants), Docker (2 variants).
#
# Prerequisites:
#   - just setup (or just build) completed
#   - gh auth login completed
#   - Docker installed (for tests 8-9)
#   - KVM available (/dev/kvm)
#
# Usage:
#   ./scripts/gauntlet-test.sh           # Run all 9 tests
#   ./scripts/gauntlet-test.sh 1 3 8     # Run specific tests only
#   ./scripts/gauntlet-test.sh --quick   # Quick smoke test (--version only)
#
# Each test:
#   1. Cleans approval store (forces fresh plugin audit)
#   2. Runs the full PPTX generation prompt
#   3. Validates: plugin load errors, PPTX schema, log locations
#
# Results are written to /tmp/hyperagent-gauntlet/
# ═══════════════════════════════════════════════════════════════════

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="/tmp/hyperagent-gauntlet"
COMMON_ARGS="--show-code --show-timing --verbose --transcript --debug --tune --auto-approve --skill pptx-expert --profile file-builder"

export HYPERAGENT_PROMPT='Research Kubernetes and create a technical conference Presentation for a talk titled "Kubernetes at Scale: Lessons learned from Running 10,000 Nodes". Use '"'"'dark-gradient'"'"' theme for a developer conference aesthetic. Include:

- Architecture overview diagrams
- Scaling challenges and solutions
- Performance benchmarks with charts
- Code snippets for key configurations
- War stories and failure modes
- Monitoring and observability setup
- Cost optimization strategies
- Open source tools comparison
- Best practices checklist

Important: Make sure to include attributions/references for data/information used, put the reference(s) on the relevant slides where the information or data are used, not on one slide at the end, you must research for these data on the Internet to augment your training data, you should favour the most recent data and information.

Target audience: DevOps engineers and SREs. 30+ slides.'

# ── Helpers ──────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

clean_state() {
  rm -f ~/.hyperagent/approved-plugins.json
}

# Extract the sandbox baseDir from the test log file.
# Looks for lines like: baseDir: /tmp/hyperlight-fs-64a42620-faa6-47
extract_base_dir() {
  local logfile="$1"
  grep -oP 'baseDir:\s+\K/tmp/hyperlight-fs-[^\s]+' "$logfile" 2>/dev/null | tail -1
}

# Find the PPTX created by THIS test using the baseDir from its log.
# For Docker tests, the container sees /tmp/hyperlight-fs-... but the host
# has the files at ~/.hyperagent/tmp/hyperlight-fs-... (volume mount).
find_test_pptx() {
  local logfile="$1"
  local base_dir
  base_dir=$(extract_base_dir "$logfile")
  if [ -z "$base_dir" ]; then return; fi

  # Extract just the directory name (e.g. hyperlight-fs-504002cf-52ca-47)
  local dir_name
  dir_name=$(basename "$base_dir")

  # Try the direct path first (non-Docker), then the Docker mount path
  local search_dirs=("$base_dir" "$HOME/.hyperagent/tmp/$dir_name")
  for d in "${search_dirs[@]}"; do
    if [ -d "$d" ]; then
      local pptx
      pptx=$(find "$d" -maxdepth 1 -name "*.pptx" -type f 2>/dev/null | head -1)
      if [ -n "$pptx" ]; then
        echo "$pptx"
        return
      fi
    fi
  done
}

validate() {
  local label="$1" logfile="$2"
  local pass=true

  echo ""
  echo -e "  ${BOLD}── VALIDATION: $label ──${NC}"

  # Show the baseDir we found
  local base_dir
  base_dir=$(extract_base_dir "$logfile")
  if [ -n "$base_dir" ]; then
    echo -e "  📂 baseDir: $base_dir"
  else
    echo -e "  ${YELLOW}⚠️  baseDir: not found in log${NC}"
  fi

  # Plugin errors
  local perr
  perr=$(grep -c "Failed to load\|Plugin.*not found\|Cannot find module" "$logfile" 2>/dev/null || echo 0)
  if [ "$perr" -gt 0 ]; then
    echo -e "  ${RED}❌ Plugin load: $perr error(s)${NC}"
    grep "Failed to load\|Plugin.*not found\|Cannot find module" "$logfile" | head -3
    pass=false
  else
    echo -e "  ${GREEN}✅ Plugin load: 0 errors${NC}"
  fi

  # Analysis guest
  local fatal
  fatal=$(grep -c "FATAL.*Analysis guest" "$logfile" 2>/dev/null || echo 0)
  if [ "$fatal" -gt 0 ]; then
    echo -e "  ${RED}❌ Analysis guest: FATAL${NC}"
    pass=false
  fi

  # PPTX validation — find via baseDir extracted from this test's log
  local pptx
  pptx=$(find_test_pptx "$logfile")
  if [ -z "$pptx" ]; then
    echo -e "  ${RED}❌ PPTX: No file found${NC}"
    pass=false
  else
    local validator_output
    validator_output=$(cd "$REPO" && npx ooxml-validator "$pptx" 2>&1)
    local ok
    ok=$(echo "$validator_output" | grep -c '"ok": true' || echo 0)
    if [ "$ok" -gt 0 ]; then
      echo -e "  ${GREEN}✅ PPTX valid${NC} ($pptx)"
    else
      echo -e "  ${RED}❌ PPTX INVALID${NC} ($pptx)"
      echo "$validator_output" | head -10
      pass=false
    fi
  fi

  # Logs in right place
  if grep -q "\.hyperagent/logs/" "$logfile" 2>/dev/null; then
    echo -e "  ${GREEN}✅ Logs dir: ~/.hyperagent/logs/${NC}"
  else
    echo -e "  ${YELLOW}⚠️  Logs dir: Could not verify log paths${NC}"
  fi

  # Plugin schema extraction (no empty configSchema)
  if grep -q "Configure remaining fields\|Configure \"" "$logfile" 2>/dev/null; then
    echo -e "  ${GREEN}✅ Plugin schema extracted${NC}"
  fi

  echo -e "  ${BOLD}── END VALIDATION ──${NC}"

  $pass && PASS_COUNT=$((PASS_COUNT + 1)) || FAIL_COUNT=$((FAIL_COUNT + 1))
}

run_test() {
  local num="$1" label="$2" cmd="$3"
  local logfile="$OUTDIR/t${num}-${label}.log"

  echo ""
  echo -e "${BOLD}═══ TEST $num: $label ═══${NC}"
  echo "  Command: $cmd"
  echo "  Log: $logfile"

  clean_state

  local start=$SECONDS
  eval "$cmd" 2>&1 | tee "$logfile"
  local duration=$(( SECONDS - start ))

  echo ""
  echo -e "  ⏱️  Duration: ${duration}s"
  validate "$label" "$logfile"
  echo ""
}

# ── Parse args ───────────────────────────────────────────────────

QUICK=false
SELECTED_TESTS=()

for arg in "$@"; do
  if [ "$arg" = "--quick" ]; then
    QUICK=true
  elif [[ "$arg" =~ ^[0-9]+$ ]]; then
    SELECTED_TESTS+=("$arg")
  fi
done

should_run() {
  local num="$1"
  if [ ${#SELECTED_TESTS[@]} -eq 0 ]; then return 0; fi
  for t in "${SELECTED_TESTS[@]}"; do
    if [ "$t" = "$num" ]; then return 0; fi
  done
  return 1
}

# ── Quick mode ───────────────────────────────────────────────────

if $QUICK; then
  echo -e "${BOLD}🚀 QUICK SMOKE TEST${NC}"
  echo ""

  echo -n "  tsx --version: "
  cd "$REPO" && npx tsx src/agent/index.ts --version 2>&1

  if [ -f "$REPO/dist/bin/hyperagent" ]; then
    echo -n "  binary --version: "
    "$REPO/dist/bin/hyperagent" --version 2>&1
  else
    echo "  binary: not built (run 'just binary' first)"
  fi

  if docker image inspect hyperagent:latest >/dev/null 2>&1; then
    echo -n "  docker --version: "
    docker run --rm hyperagent:latest --version 2>&1
  else
    echo "  docker: no image (run 'docker build' first)"
  fi

  echo ""
  echo -e "${GREEN}✅ Smoke test complete${NC}"
  exit 0
fi

# ── Full gauntlet ────────────────────────────────────────────────

rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"
PASS_COUNT=0
FAIL_COUNT=0

echo -e "${BOLD}🚀 HYPERAGENT GAUNTLET TEST${NC}"
echo "   $(date)"
echo "   Repo: $REPO"
echo "   Args: $COMMON_ARGS"
echo "   Output: $OUTDIR"
echo ""

# T1: just start (tsx, debug addons)
should_run 1 && run_test 1 "just-start" \
  "cd $REPO && just start $COMMON_ARGS"

# T2: just start-release (tsx, release addons)
should_run 2 && run_test 2 "just-start-release" \
  "cd $REPO && just start-release $COMMON_ARGS"

# T3: just start-debug (tsx, crash diagnostics)
should_run 3 && run_test 3 "just-start-debug" \
  "cd $REPO && just start-debug $COMMON_ARGS"

# T4: just run (builds debug binary, then runs it)
should_run 4 && run_test 4 "just-run" \
  "cd $REPO && just run $COMMON_ARGS"

# T5: just run-release (builds release binary, then runs it)
should_run 5 && run_test 5 "just-run-release" \
  "cd $REPO && just run-release $COMMON_ARGS"

# T6: just binary + manual dist/bin/hyperagent
should_run 6 && {
  echo -e "${BOLD}═══ TEST 6: Building debug binary... ═══${NC}"
  clean_state
  cd "$REPO" && just binary 2>&1 | tail -3
  run_test 6 "binary-debug-manual" \
    "cd $REPO && dist/bin/hyperagent $COMMON_ARGS"
}

# T7: just binary-release + manual dist/bin/hyperagent
should_run 7 && {
  echo -e "${BOLD}═══ TEST 7: Building release binary... ═══${NC}"
  clean_state
  cd "$REPO" && just binary-release 2>&1 | tail -3
  run_test 7 "binary-release-manual" \
    "cd $REPO && dist/bin/hyperagent $COMMON_ARGS"
}

# T8: docker build + docker run
should_run 8 && {
  echo -e "${BOLD}═══ TEST 8: Building Docker image... ═══${NC}"
  cd "$REPO" && docker build --build-arg VERSION=gauntlet -t hyperagent:latest . 2>&1 | tail -3
  mkdir -p ~/.hyperagent/tmp
  run_test 8 "docker-run" \
    "docker run --rm --device=/dev/kvm \
      --group-add \$(stat -c '%g' /dev/kvm) \
      --user \"\$(id -u):\$(id -g)\" \
      -e HOME=/home/hyperagent \
      -e GITHUB_TOKEN=\"\$(gh auth token)\" \
      -e HYPERAGENT_PROMPT=\"\$HYPERAGENT_PROMPT\" \
      -v \"\$HOME/.hyperagent:/home/hyperagent/.hyperagent\" \
      -v \"\$HOME/.hyperagent/tmp:/tmp\" \
      -v \"\$(pwd)\":/workspace -w /workspace \
      hyperagent:latest $COMMON_ARGS"
}

# T9: docker script
should_run 9 && {
  run_test 9 "docker-script" \
    "cd $REPO && ./scripts/hyperagent-docker $COMMON_ARGS"
}

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}   GAUNTLET RESULTS${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo ""
echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "  ${RED}Failed: $FAIL_COUNT${NC}"
echo ""
echo "  Logs: $OUTDIR"
echo "  $(date)"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "  ${RED}❌ SOME TESTS FAILED${NC}"
  exit 1
else
  echo -e "  ${GREEN}✅ ALL TESTS PASSED — SHIP IT! 🚀${NC}"
  exit 0
fi
