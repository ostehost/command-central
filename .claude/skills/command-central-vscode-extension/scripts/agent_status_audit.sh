#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_NAME="agent_status_audit.sh"
readonly VERSION="1.0.0"

usage() {
  cat <<'USAGE'
Usage: agent_status_audit.sh [OPTIONS]

Read-only audit of all Agent Status data sources.

Options:
  --json               Output as JSON (default: human-readable)
  --tasks-file PATH    Explicit tasks.json path (overrides auto-detection)
  --pending-dir PATH   Pending-review directory (default: $CC_PENDING_REVIEW_DIR or /tmp/oste-pending-review)
  --home PATH          Override $HOME for path resolution
  --workspace PATH     Override $PWD for workspace-local tasks.json detection
  -h, --help           Show this help message
  -V, --version        Show version

Resolution chain for tasks.json (first match wins):
  1. --tasks-file flag
  2. TASKS_FILE environment variable
  3. <workspace>/.ghostty-launcher/tasks.json
  4. <home>/.config/ghostty-launcher/tasks.json
  5. <home>/.ghostty-launcher/tasks.json

Requires: jq
USAGE
}

# --- Argument parsing ---

json_output=false
opt_tasks_file=""
opt_pending_dir=""
opt_home="${HOME}"
opt_workspace="${PWD}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)        json_output=true; shift ;;
    --tasks-file)  opt_tasks_file="${2:?--tasks-file requires a path}"; shift 2 ;;
    --pending-dir) opt_pending_dir="${2:?--pending-dir requires a path}"; shift 2 ;;
    --home)        opt_home="${2:?--home requires a path}"; shift 2 ;;
    --workspace)   opt_workspace="${2:?--workspace requires a path}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    -V|--version)  echo "$SCRIPT_NAME $VERSION"; exit 0 ;;
    *)             echo "error: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# --- Dependency check ---

if ! command -v jq &>/dev/null; then
  echo "error: jq is required but not found in PATH" >&2
  exit 1
fi

# --- Path resolution ---

resolve_tasks_file() {
  if [[ -n "$opt_tasks_file" ]]; then
    if [[ -f "$opt_tasks_file" ]]; then
      echo "$opt_tasks_file"
      return 0
    fi
    echo "error: --tasks-file not found: $opt_tasks_file" >&2
    return 1
  fi

  if [[ -n "${TASKS_FILE:-}" && -f "$TASKS_FILE" ]]; then
    echo "$TASKS_FILE"
    return 0
  fi

  local ws="$opt_workspace"
  if [[ -f "$ws/.ghostty-launcher/tasks.json" ]]; then
    echo "$ws/.ghostty-launcher/tasks.json"
    return 0
  fi

  if [[ -f "$opt_home/.config/ghostty-launcher/tasks.json" ]]; then
    echo "$opt_home/.config/ghostty-launcher/tasks.json"
    return 0
  fi

  if [[ -f "$opt_home/.ghostty-launcher/tasks.json" ]]; then
    echo "$opt_home/.ghostty-launcher/tasks.json"
    return 0
  fi

  return 1
}

resolve_pending_dir() {
  if [[ -n "$opt_pending_dir" ]]; then
    echo "$opt_pending_dir"
  elif [[ -n "${CC_PENDING_REVIEW_DIR:-}" ]]; then
    echo "$CC_PENDING_REVIEW_DIR"
  else
    echo "/tmp/oste-pending-review"
  fi
}

# --- Data collection ---

tasks_file=""
tasks_found=false
tasks_total=0
tasks_running=0
tasks_by_status="{}"

if tasks_file=$(resolve_tasks_file); then
  tasks_found=true
  if [[ -f "$tasks_file" && -s "$tasks_file" ]]; then
    tasks_total=$(jq '[.tasks // {} | to_entries[]] | length' "$tasks_file" 2>/dev/null || echo 0)
    tasks_running=$(jq '[.tasks // {} | to_entries[] | select(.value.status == "running")] | length' "$tasks_file" 2>/dev/null || echo 0)
    # Coerce null/missing status to a stable "unknown" bucket. A null key would
    # make `from_entries` error and silently collapse the whole breakdown to {},
    # hiding even the valid running/completed counts (malformed launcher-era rows
    # without a status do occur in live registries).
    tasks_by_status=$(jq '
      [.tasks // {} | to_entries[] | (.value.status // "unknown")] |
      group_by(.) | map({key: .[0], value: length}) | from_entries
    ' "$tasks_file" 2>/dev/null || echo '{}')
  fi
else
  tasks_file="(not found)"
fi

pending_dir=$(resolve_pending_dir)
pending_active=0
pending_reviewed_sub=0
pending_quarantined=0
pending_total=0
if [[ -d "$pending_dir" ]]; then
  pending_active=$(find "$pending_dir" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ -d "$pending_dir/reviewed" ]]; then
    pending_reviewed_sub=$(find "$pending_dir/reviewed" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')
  fi
  if [[ -d "$pending_dir/quarantined" ]]; then
    pending_quarantined=$(find "$pending_dir/quarantined" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')
  fi
fi
pending_total=$((pending_active + pending_reviewed_sub + pending_quarantined))

reviewed_file="$opt_home/.config/command-central/reviewed-tasks.json"
reviewed_count=0
reviewed_found=false
if [[ -f "$reviewed_file" ]]; then
  reviewed_found=true
  reviewed_count=$(jq '[.reviewed // [] | .[]] | length' "$reviewed_file" 2>/dev/null || echo 0)
fi

stream_count=0
stream_count=$(find /tmp -maxdepth 1 -name '*-stream-*.jsonl' -type f 2>/dev/null | wc -l | tr -d ' ')

# Work System lanes projection (second registry feed the tree reads; see
# commandCentral.laneRegistry.files default).
lanes_file="$opt_home/.config/openclaw/lanes.json"
lanes_found=false
lanes_kind=""
lanes_count=0
if [[ -f "$lanes_file" ]]; then
  lanes_found=true
  lanes_kind=$(jq -r '.kind // ""' "$lanes_file" 2>/dev/null || echo "")
  lanes_count=$(jq '.lanes // {} | length' "$lanes_file" 2>/dev/null || echo 0)
fi

openclaw_available=false
openclaw_task_total=0
openclaw_task_running=0
openclaw_flow_total=0
openclaw_flow_active=0

if command -v openclaw &>/dev/null; then
  openclaw_available=true
  if oc_tasks=$(openclaw tasks list --json 2>/dev/null) && [[ -n "$oc_tasks" ]]; then
    openclaw_task_total=$(echo "$oc_tasks" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)
    openclaw_task_running=$(echo "$oc_tasks" | jq '[.[]? | select(.status == "running")] | length' 2>/dev/null || echo 0)
  fi
  if oc_flows=$(openclaw tasks flow list --json 2>/dev/null) && [[ -n "$oc_flows" ]]; then
    openclaw_flow_total=$(echo "$oc_flows" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)
    openclaw_flow_active=$(echo "$oc_flows" | jq '[.[]? | select(.status == "running" or .status == "waiting")] | length' 2>/dev/null || echo 0)
  fi
fi

# Best-effort discovery setting
discovery_enabled="unknown"
vscode_settings=""
if [[ "$(uname)" == "Darwin" ]]; then
  vscode_settings="$opt_home/Library/Application Support/Code/User/settings.json"
elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
  vscode_settings="$XDG_CONFIG_HOME/Code/User/settings.json"
else
  vscode_settings="$opt_home/.config/Code/User/settings.json"
fi
if [[ -f "$vscode_settings" ]]; then
  raw=$(grep -o '"commandCentral\.discovery\.enabled"[[:space:]]*:[[:space:]]*\(true\|false\)' "$vscode_settings" 2>/dev/null || true)
  if [[ "$raw" == *"false"* ]]; then
    discovery_enabled="false"
  elif [[ "$raw" == *"true"* ]]; then
    discovery_enabled="true"
  fi
fi

# --- Output ---

# Compact tasks_by_status to single line for safe --argjson
tasks_by_status_compact=$(echo "$tasks_by_status" | jq -c '.' 2>/dev/null || echo '{}')

if $json_output; then
  jq -n \
    --argjson tasks_found "$tasks_found" \
    --arg tasks_file "$tasks_file" \
    --argjson tasks_total "${tasks_total:-0}" \
    --argjson tasks_running "${tasks_running:-0}" \
    --argjson tasks_by_status "$tasks_by_status_compact" \
    --arg pending_dir "$pending_dir" \
    --argjson pending_active "${pending_active:-0}" \
    --argjson pending_reviewed_sub "${pending_reviewed_sub:-0}" \
    --argjson pending_quarantined "${pending_quarantined:-0}" \
    --argjson pending_total "${pending_total:-0}" \
    --argjson reviewed_found "$reviewed_found" \
    --arg reviewed_file "$reviewed_file" \
    --argjson reviewed_count "${reviewed_count:-0}" \
    --argjson stream_count "${stream_count:-0}" \
    --argjson lanes_found "$lanes_found" \
    --arg lanes_file "$lanes_file" \
    --arg lanes_kind "$lanes_kind" \
    --argjson lanes_count "${lanes_count:-0}" \
    --argjson openclaw_available "$openclaw_available" \
    --argjson openclaw_task_total "${openclaw_task_total:-0}" \
    --argjson openclaw_task_running "${openclaw_task_running:-0}" \
    --argjson openclaw_flow_total "${openclaw_flow_total:-0}" \
    --argjson openclaw_flow_active "${openclaw_flow_active:-0}" \
    --arg discovery_enabled "$discovery_enabled" \
    '{
      tasks: {
        found: $tasks_found,
        file: $tasks_file,
        total: $tasks_total,
        running: $tasks_running,
        by_status: $tasks_by_status
      },
      pending_review: {
        dir: $pending_dir,
        active: $pending_active,
        reviewed: $pending_reviewed_sub,
        quarantined: $pending_quarantined,
        total: $pending_total
      },
      reviewed_tasks: {
        found: $reviewed_found,
        file: $reviewed_file,
        count: $reviewed_count
      },
      streams: {
        count: $stream_count
      },
      lanes_projection: {
        found: $lanes_found,
        file: $lanes_file,
        kind: $lanes_kind,
        lanes: $lanes_count
      },
      openclaw: {
        available: $openclaw_available,
        tasks: { total: $openclaw_task_total, running: $openclaw_task_running },
        flows: { total: $openclaw_flow_total, active: $openclaw_flow_active }
      },
      discovery: {
        enabled: $discovery_enabled
      }
    }'
else
  echo "Agent Status Audit"
  echo "=================="
  echo ""
  echo "Tasks Registry: $tasks_file"
  if $tasks_found; then
    echo "  Total:    $tasks_total"
    echo "  Running:  $tasks_running"
    if [[ "$tasks_by_status" != "{}" ]]; then
      echo "  By status:"
      echo "$tasks_by_status" | jq -r 'to_entries[] | "    \(.key): \(.value)"'
    fi
  else
    echo "  (no tasks.json found)"
  fi
  echo ""
  echo "Pending Review: $pending_dir"
  if [[ -d "$pending_dir" ]]; then
    echo "  Active:      $pending_active"
    echo "  Reviewed:    $pending_reviewed_sub"
    echo "  Quarantined: $pending_quarantined"
    echo "  Total:       $pending_total"
  else
    echo "  (directory not found)"
  fi
  echo ""
  echo "Reviewed Tasks: $reviewed_file"
  if $reviewed_found; then
    echo "  Reviewed: $reviewed_count"
  else
    echo "  (file not found)"
  fi
  echo ""
  echo "Stream Files: /tmp/*-stream-*.jsonl"
  echo "  Count: $stream_count"
  echo ""
  echo "Lanes Projection: $lanes_file"
  if $lanes_found; then
    echo "  Kind:  ${lanes_kind:-<none>}"
    echo "  Lanes: $lanes_count"
  else
    echo "  (file not found)"
  fi
  echo ""
  echo "OpenClaw:"
  if $openclaw_available; then
    echo "  Available: yes"
    echo "  Tasks: $openclaw_task_total ($openclaw_task_running running)"
    echo "  Flows: $openclaw_flow_total ($openclaw_flow_active active)"
  else
    echo "  Available: no (openclaw not in PATH)"
  fi
  echo ""
  echo "Discovery:"
  echo "  Enabled: $discovery_enabled"
  if [[ "$discovery_enabled" == "unknown" ]]; then
    echo "  (cannot reliably read VS Code settings from CLI)"
  fi
fi
