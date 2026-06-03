#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# Custom MOSS TUI Status Bar Script
# 
# Reads JSON session data from stdin and outputs a formatted status line.
# Configure via ~/.dmoss/config.json: { "statusBarScript": "/path/to/script" }
#
# Expected stdin JSON format:
# {
#   "model": "claude-sonnet-4-20250514",
#   "sessionName": "my-project",
#   "messageCount": 42,
#   "toolCalls": 7,
#   "contextUsed": 35000,
#   "contextLimit": 200000,
#   "mode": "default",             // "default" | "plan" | "auto-accept" | "fast"
#   "agentState": "idle",          // "idle" | "streaming" | "tool-running" | "awaiting-approval"
#   "elapsedSeconds": 123,
#   "costEstimate": 0.42,
#   "vimMode": "",                 // "" | "NORMAL" | "INSERT" | "VISUAL"
#   "gitBranch": "main",
#   "dirtyFiles": 3
# }
# ────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Read JSON from stdin (first line only, to handle multi-line streaming)
INPUT=$(head -1)

# ── Parse fields with jq (fall back to defaults if missing) ──
MODEL=$(echo "$INPUT" | jq -r '.model // "unknown"')
SESSION=$(echo "$INPUT" | jq -r '.sessionName // ""')
MSG_COUNT=$(echo "$INPUT" | jq -r '.messageCount // 0')
TOOL_COUNT=$(echo "$INPUT" | jq -r '.toolCalls // 0')
CTX_USED=$(echo "$INPUT" | jq -r '.contextUsed // 0')
CTX_LIMIT=$(echo "$INPUT" | jq -r '.contextLimit // 200000')
MODE=$(echo "$INPUT" | jq -r '.mode // "default"')
STATE=$(echo "$INPUT" | jq -r '.agentState // "idle"')
ELAPSED=$(echo "$INPUT" | jq -r '.elapsedSeconds // 0')
COST=$(echo "$INPUT" | jq -r '.costEstimate // 0')
VIM_MODE=$(echo "$INPUT" | jq -r '.vimMode // ""')
GIT_BRANCH=$(echo "$INPUT" | jq -r '.gitBranch // ""')
DIRTY=$(echo "$INPUT" | jq -r '.dirtyFiles // 0')

# ── Compute context usage % ──
if [ "$CTX_LIMIT" -gt 0 ] 2>/dev/null; then
  CTX_PCT=$(( CTX_USED * 100 / CTX_LIMIT ))
else
  CTX_PCT=0
fi

# ── State indicator ──
case "$STATE" in
  "streaming")       STATE_ICON="◉" ;;
  "tool-running")    STATE_ICON="⚙" ;;
  "awaiting-approval") STATE_ICON="?" ;;
  *)                 STATE_ICON="✓" ;;
esac

# ── Mode badge ──
MODE_BADGE=""
case "$MODE" in
  "plan")        MODE_BADGE="[plan]" ;;
  "auto-accept") MODE_BADGE="[auto]" ;;
  "fast")        MODE_BADGE="[fast]" ;;
esac

# ── Context usage bar (unicode block characters) ──
build_usage_bar() {
  local pct=$1
  local filled=$(( pct / 10 ))
  local bar=""
  for i in $(seq 1 10); do
    if [ "$i" -le "$filled" ]; then
      bar="${bar}█"
    else
      bar="${bar}░"
    fi
  done
  echo "$bar"
}
USAGE_BAR=$(build_usage_bar "$CTX_PCT")

# ── Format elapsed time ──
format_time() {
  local secs=$1
  if [ "$secs" -lt 60 ]; then
    echo "${secs}s"
  elif [ "$secs" -lt 3600 ]; then
    echo "$(( secs / 60 ))m$(( secs % 60 ))s"
  else
    echo "$(( secs / 3600 ))h$(( (secs % 3600) / 60 ))m"
  fi
}
ELAPSED_STR=$(format_time "$ELAPSED")

# ── Git status ──
GIT_INFO=""
if [ -n "$GIT_BRANCH" ]; then
  GIT_INFO="⎇ $GIT_BRANCH"
  if [ "$DIRTY" -gt 0 ] 2>/dev/null; then
    GIT_INFO="$GIT_INFO ±$DIRTY"
  fi
fi

# ── Vim mode indicator ──
VIM_INDICATOR=""
if [ -n "$VIM_MODE" ]; then
  VIM_INDICATOR="-- $VIM_MODE --"
fi

# ── Cost ──
COST_STR=""
if [ "$(echo "$COST > 0" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
  COST_STR="\$$(printf '%.2f' "$COST")"
fi

# ── Assemble status line ──
# Format: [session] model · msg/tool · ctx bar pct · git · time · cost · mode · vim
STATUS=""

[ -n "$SESSION" ] && STATUS="$STATUS [$SESSION]"
STATUS="$STATUS $MODEL"
STATUS="$STATUS · $MSG_COUNT msgs / $TOOL_COUNT tools"
STATUS="$STATUS · $USAGE_BAR ${CTX_PCT}%"
[ -n "$GIT_INFO" ] && STATUS="$STATUS · $GIT_INFO"
STATUS="$STATUS · $STATE_ICON $ELAPSED_STR"
[ -n "$COST_STR" ] && STATUS="$STATUS · $COST_STR"
[ -n "$MODE_BADGE" ] && STATUS="$STATUS $MODE_BADGE"
[ -n "$VIM_INDICATOR" ] && STATUS="$STATUS $VIM_INDICATOR"

echo "$STATUS"
