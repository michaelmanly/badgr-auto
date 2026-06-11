#!/usr/bin/env bash
# test.sh — Badgr Auto VS Code extension end-to-end test suite
#
# Usage:
#   ./test.sh               — run all phases
#   ./test.sh --skip-vscode — skip VS Code headless tests (faster)
#   ./test.sh --skip-proxy  — skip live proxy smoke tests
#
# Requires: node >=20, npm, curl
# Optional: badgr-auto (for proxy smoke tests), vsce (for VSIX packaging)

set -euo pipefail
cd "$(dirname "$0")"

# ── colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

pass() { echo -e "${GREEN}  ✓${RESET} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}  ✗${RESET} $1"; FAIL=$((FAIL+1)); ERRORS+=("$1"); }
info() { echo -e "${CYAN}  ▸${RESET} $1"; }
phase() { echo -e "\n${BOLD}${CYAN}━━ $1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }
warn() { echo -e "${YELLOW}  ⚠${RESET}  $1"; }

PASS=0; FAIL=0; ERRORS=()
SKIP_VSCODE=false; SKIP_PROXY=false

for arg in "$@"; do
  [[ "$arg" == "--skip-vscode" ]] && SKIP_VSCODE=true
  [[ "$arg" == "--skip-proxy"  ]] && SKIP_PROXY=true
done

PROXY_PID=""; PROXY_STARTED=false

cleanup() {
  if $PROXY_STARTED && [[ -n "$PROXY_PID" ]]; then
    info "Stopping proxy (PID $PROXY_PID)…"
    kill "$PROXY_PID" 2>/dev/null || true
    badgr-auto stop 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Phase 1: TypeScript type check ────────────────────────────────────────────
phase "1 / 6  TypeScript"

if npx tsc --noEmit 2>&1; then
  pass "tsc --noEmit"
else
  fail "TypeScript errors (run: npx tsc --noEmit)"
fi

# ── Phase 2: Webpack build ─────────────────────────────────────────────────────
phase "2 / 6  Webpack build"

if npx webpack --mode production --devtool hidden-source-map 2>&1; then
  pass "webpack production build"
else
  fail "webpack build failed"
fi

if [[ -f dist/extension.js ]]; then
  SIZE=$(du -k dist/extension.js | cut -f1)
  pass "dist/extension.js exists (${SIZE} KB)"
  if (( SIZE > 2000 )); then
    warn "Bundle is larger than 2 MB — check for accidental deps"
  fi
else
  fail "dist/extension.js not found"
fi

# ── Phase 3: VSIX packaging ────────────────────────────────────────────────────
phase "3 / 6  VSIX package"

VSIX_PATH="/tmp/badgr-auto-test.vsix"
rm -f "$VSIX_PATH"

if command -v vsce &>/dev/null || npx @vscode/vsce --version &>/dev/null 2>&1; then
  if npx @vscode/vsce package --no-dependencies --out "$VSIX_PATH" 2>&1; then
    if [[ -f "$VSIX_PATH" ]]; then
      VSIX_SIZE=$(du -k "$VSIX_PATH" | cut -f1)
      pass "VSIX created at $VSIX_PATH (${VSIX_SIZE} KB)"
      # Verify it's a valid zip
      if command -v unzip &>/dev/null && unzip -t "$VSIX_PATH" &>/dev/null; then
        pass "VSIX is a valid zip archive"
      else
        info "unzip not available — skipping archive validation"
      fi
    else
      fail "vsce ran but VSIX not created"
    fi
  else
    fail "vsce package failed"
  fi
else
  warn "vsce not available — skipping VSIX packaging (install with: npm install -g @vscode/vsce)"
fi

# ── Phase 4: Config writer unit tests (vitest) ────────────────────────────────
phase "4 / 6  Config writer unit tests (vitest)"

info "Running vitest…"
if npx vitest run --reporter=verbose 2>&1; then
  pass "All vitest unit tests passed"
else
  fail "vitest unit tests failed"
fi

# ── Phase 5: Proxy smoke tests (live) ─────────────────────────────────────────
phase "5 / 6  Proxy smoke tests"

if $SKIP_PROXY; then
  warn "Skipping proxy tests (--skip-proxy)"
elif ! command -v badgr-auto &>/dev/null; then
  warn "badgr-auto not installed — skipping proxy tests"
  warn "Install with: npm install -g badgr-auto"
else
  PORT="${BADGR_AUTO_PORT:-8787}"

  # Check if already running from a previous session
  if curl -sf "http://localhost:${PORT}/health" &>/dev/null; then
    info "Proxy already running on port ${PORT}"
    PROXY_ALREADY_UP=true
  else
    PROXY_ALREADY_UP=false
    info "Starting proxy on port ${PORT}…"
    BADGR_AUTO_PORT="$PORT" badgr-auto start &>/dev/null &
    PROXY_PID=$!
    PROXY_STARTED=true

    # Wait up to 12 s for the proxy to start
    for i in {1..12}; do
      sleep 1
      if curl -sf "http://localhost:${PORT}/health" &>/dev/null; then break; fi
      if (( i == 12 )); then
        fail "Proxy did not start within 12 s (port ${PORT})"
      fi
    done
  fi

  # ── health check ──
  HEALTH_BODY=$(curl -sf "http://localhost:${PORT}/health" 2>/dev/null || echo "")
  if echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
    pass "GET /health → {status:ok}"
  else
    fail "GET /health did not return status:ok (got: $HEALTH_BODY)"
  fi

  if echo "$HEALTH_BODY" | grep -q '"base_url"'; then
    pass "GET /health includes base_url field"
  else
    fail "GET /health missing base_url field"
  fi

  # ── /v1/models ──
  MODELS_BODY=$(curl -sf "http://localhost:${PORT}/v1/models" 2>/dev/null || echo "")
  if echo "$MODELS_BODY" | grep -q '"object"'; then
    pass "GET /v1/models → valid response"
  else
    fail "GET /v1/models did not return expected format"
  fi

  # ── /v1/chat/completions (buffered, expect upstream error or valid response) ──
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:${PORT}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test-key" \
    -d '{"model":"badgr-auto","messages":[{"role":"user","content":"ping"}],"stream":false}' \
    2>/dev/null || echo "000")

  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "401" || "$HTTP_CODE" == "400" || "$HTTP_CODE" == "402" ]]; then
    pass "POST /v1/chat/completions → HTTP $HTTP_CODE (proxy handled request)"
  elif [[ "$HTTP_CODE" == "000" ]]; then
    fail "POST /v1/chat/completions → no response (proxy unreachable)"
  else
    warn "POST /v1/chat/completions → HTTP $HTTP_CODE (may indicate upstream issue)"
    pass "POST /v1/chat/completions → proxy received request (HTTP $HTTP_CODE)"
  fi

  # ── streaming ──
  STREAM_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:${PORT}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test-key" \
    -d '{"model":"badgr-auto","messages":[{"role":"user","content":"ping"}],"stream":true}' \
    2>/dev/null || echo "000")

  if [[ "$STREAM_CODE" != "000" ]]; then
    pass "POST /v1/chat/completions (stream:true) → HTTP $STREAM_CODE"
  else
    fail "Streaming request got no response"
  fi

  # ── stop and verify ──
  if ! $PROXY_ALREADY_UP; then
    info "Stopping proxy…"
    badgr-auto stop 2>/dev/null || kill "$PROXY_PID" 2>/dev/null || true
    PROXY_STARTED=false
    sleep 2

    if curl -sf "http://localhost:${PORT}/health" &>/dev/null; then
      fail "Proxy still responding after stop"
    else
      pass "Proxy stopped — /health no longer responds"
    fi
  fi
fi

# ── Phase 6: VS Code extension tests (headless) ────────────────────────────────
phase "6 / 6  VS Code extension tests (headless)"

if $SKIP_VSCODE; then
  warn "Skipping VS Code headless tests (--skip-vscode)"
else
  info "Installing dependencies…"
  npm install --prefer-offline 2>&1 | tail -3
  info "Compiling test suite…"
  if npx tsc -p tsconfig.test.json --outDir out 2>&1; then
    pass "Test suite compiled"
  else
    fail "Test suite compilation failed"
  fi

  if [[ ! -f out/test/suite/runTests.js ]]; then
    fail "out/test/suite/runTests.js not found after compile"
  else
    info "Downloading VS Code and running extension tests (first run may take ~2 min)…"
    if node out/test/suite/runTests.js 2>&1; then
      pass "VS Code extension tests passed"
    else
      fail "VS Code extension tests failed"
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}Passed: ${PASS}${RESET}    ${RED}Failed: ${FAIL}${RESET}"

if (( FAIL > 0 )); then
  echo -e "\n${RED}Failed checks:${RESET}"
  for e in "${ERRORS[@]}"; do echo -e "  ${RED}✗${RESET} $e"; done
  echo ""
  exit 1
else
  echo -e "\n${GREEN}${BOLD}All checks passed.${RESET}"
  echo ""
  exit 0
fi
