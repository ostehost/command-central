#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_NAME="fresh_slate_reset.sh"
readonly VERSION="1.2.0"

usage() {
  cat <<'USAGE'
Usage: fresh_slate_reset.sh [OPTIONS]

Backup-first reset of Agent Status historical state.

Dry-run by default. Pass --apply to execute the reset.
Never kills processes. Never edits VS Code settings.

Options:
  --dry-run              Show what would happen without changing anything (default)
  --apply                Execute the reset (required for mutation)
  --json                 Output as JSON
  --backup-root PATH     Backup directory root (default: <home>/.config/command-central/backups)
  --tasks-file PATH      Explicit tasks.json path (overrides auto-detection)
  --pending-dir PATH     Pending-review directory (default: $CC_PENDING_REVIEW_DIR or /tmp/oste-pending-review)
  --home PATH            Override $HOME for path resolution
  --workspace PATH       Override $PWD for workspace-local tasks.json detection
  --include-streams      Also back up stream JSONL files from /tmp
  --force-running        Allow reset even if running tasks exist
  -h, --help             Show this help message
  -V, --version          Show version

Resolution chain for tasks.json (first match wins):
  1. --tasks-file flag
  2. TASKS_FILE environment variable
  3. <workspace>/.ghostty-launcher/tasks.json
  4. <home>/.config/ghostty-launcher/tasks.json
  5. <home>/.ghostty-launcher/tasks.json

Safety:
  - Refuses --apply if running launcher tasks exist (override with --force-running)
  - Acquires the launcher's tasks.json lock before mutation (compatible with tasks-lock.sh)
  - Writes manifest.json (path + sha256 + size per file) into the backup
    directory BEFORE any file is moved
  - All historical files are moved into a timestamped backup directory
  - Full pending-review store backed up (including reviewed/ and quarantined/ subdirs)
  - Empty scaffolds are recreated after backup
  - Print rollback path after completion

Note: Live discovery may still populate Agent Status after reset. Disable
commandCentral.discovery.enabled through VS Code Settings or an extension
command that uses the VS Code configuration API, then reload the window.

Requires: jq
USAGE
}

# --- Argument parsing ---

mode="dry-run"
json_output=false
opt_tasks_file=""
opt_pending_dir=""
opt_home="${HOME}"
opt_workspace="${PWD}"
opt_backup_root=""
include_streams=false
force_running=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)         mode="dry-run"; shift ;;
    --apply)           mode="apply"; shift ;;
    --json)            json_output=true; shift ;;
    --backup-root)     opt_backup_root="${2:?--backup-root requires a path}"; shift 2 ;;
    --tasks-file)      opt_tasks_file="${2:?--tasks-file requires a path}"; shift 2 ;;
    --pending-dir)     opt_pending_dir="${2:?--pending-dir requires a path}"; shift 2 ;;
    --home)            opt_home="${2:?--home requires a path}"; shift 2 ;;
    --workspace)       opt_workspace="${2:?--workspace requires a path}"; shift 2 ;;
    --include-streams) include_streams=true; shift ;;
    --force-running)   force_running=true; shift ;;
    -h|--help)         usage; exit 0 ;;
    -V|--version)      echo "$SCRIPT_NAME $VERSION"; exit 0 ;;
    *)                 echo "error: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# --- Dependency check ---

if ! command -v jq &>/dev/null; then
  echo "error: jq is required but not found in PATH" >&2
  exit 1
fi

# --- Launcher lock (compatible with tasks-lock.sh) ---

_tasks_lock_held=""

lock_tasks() {
  local file="$1"
  local lockdir="${file}.lock"
  local pidfile="${lockdir}/pid"
  local max_wait=10
  local stale_age=60
  local waited=0

  while true; do
    if mkdir "$lockdir" 2>/dev/null; then
      echo "$$" >"$pidfile"
      _tasks_lock_held="$lockdir"
      return 0
    fi

    # Stale detection: age-based
    local lock_mtime now age
    lock_mtime=$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0)
    now=$(date +%s)
    age=$((now - lock_mtime))
    if [[ $age -ge $stale_age ]]; then
      echo "warning: removing stale tasks.json lock (age: ${age}s)" >&2
      rm -rf "$lockdir"
      continue
    fi

    # Stale detection: PID-based
    if [[ -f "$pidfile" ]]; then
      local held_pid
      held_pid=$(cat "$pidfile" 2>/dev/null || echo "")
      if [[ -n "$held_pid" ]] && ! kill -0 "$held_pid" 2>/dev/null; then
        echo "warning: removing tasks.json lock held by dead PID ${held_pid}" >&2
        rm -rf "$lockdir"
        continue
      fi
    fi

    sleep 0.1
    waited=$((waited + 1))
    if [[ $waited -ge $((max_wait * 10)) ]]; then
      echo "error: tasks.json lock timeout after ${max_wait}s" >&2
      return 1
    fi
  done
}

unlock_tasks() {
  if [[ -n "$_tasks_lock_held" ]]; then
    rm -rf "$_tasks_lock_held" 2>/dev/null || true
    _tasks_lock_held=""
  fi
}

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

# --- Resolve all paths ---

tasks_file=""
tasks_found=false
if tasks_file=$(resolve_tasks_file); then
  tasks_found=true
fi

pending_dir=$(resolve_pending_dir)
reviewed_file="$opt_home/.config/command-central/reviewed-tasks.json"
backup_root="${opt_backup_root:-$opt_home/.config/command-central/backups}"
backup_dir="$backup_root/fresh-slate-$(date +%Y%m%d-%H%M%S)"

# --- Check for running tasks ---

running_count=0
if $tasks_found && [[ -f "$tasks_file" && -s "$tasks_file" ]]; then
  running_count=$(jq '[.tasks // {} | to_entries[] | select(.value.status == "running")] | length' "$tasks_file" 2>/dev/null || echo 0)
fi

if [[ "$running_count" -gt 0 ]] && ! $force_running; then
  if $json_output; then
    jq -n \
      --arg mode "$mode" \
      --argjson running_count "$running_count" \
      --arg tasks_file "$tasks_file" \
      '{
        error: "running_tasks_detected",
        message: "Refusing reset: \($running_count) running task(s) in \($tasks_file). Use --force-running to override.",
        running_count: $running_count,
        tasks_file: $tasks_file
      }'
  else
    echo "error: $running_count running task(s) detected in $tasks_file" >&2
    echo "Refusing to reset while tasks are running." >&2
    echo "Use --force-running to override (will NOT kill running agents)." >&2
  fi
  exit 1
fi

# --- Inventory pending-review store (full directory tree) ---

pending_top_count=0
pending_reviewed_count=0
pending_quarantined_count=0
pending_total=0

if [[ -d "$pending_dir" ]]; then
  pending_top_count=$(find "$pending_dir" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ -d "$pending_dir/reviewed" ]]; then
    pending_reviewed_count=$(find "$pending_dir/reviewed" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')
  fi
  if [[ -d "$pending_dir/quarantined" ]]; then
    pending_quarantined_count=$(find "$pending_dir/quarantined" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')
  fi
fi
pending_total=$((pending_top_count + pending_reviewed_count + pending_quarantined_count))

# --- Inventory stream files ---

stream_files=()
if $include_streams; then
  while IFS= read -r f; do
    stream_files+=("$f")
  done < <(find /tmp -maxdepth 1 -name '*-stream-*.jsonl' -type f 2>/dev/null || true)
fi

# --- Backup manifest (receipt written before any mutation) ---

checksum_file() {
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "unavailable"
  fi
}

# Collect every file the apply phase will move (NUL-safe is unnecessary —
# these are launcher-owned paths without newlines).
collect_manifest_files() {
  if $tasks_found && [[ -f "$tasks_file" ]]; then
    echo "$tasks_file"
  fi
  if [[ -f "$reviewed_file" ]]; then
    echo "$reviewed_file"
  fi
  if [[ -d "$pending_dir" && "$pending_total" -gt 0 ]]; then
    find "$pending_dir" -type f -name '*.json' 2>/dev/null || true
  fi
  if $include_streams && [[ ${#stream_files[@]} -gt 0 ]]; then
    printf '%s\n' "${stream_files[@]}"
  fi
}

write_manifest() {
  local manifest="$backup_dir/manifest.json"
  local entries="[]"
  local f size
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    size=$(wc -c <"$f" | tr -d ' ')
    entries=$(jq \
      --arg path "$f" \
      --arg sha256 "$(checksum_file "$f")" \
      --argjson size "$size" \
      '. + [{path: $path, sha256: $sha256, size: $size}]' <<<"$entries")
  done < <(collect_manifest_files)

  jq -n \
    --arg script "$SCRIPT_NAME" \
    --arg version "$VERSION" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg backup_dir "$backup_dir" \
    --argjson files "$entries" \
    '{
      script: $script,
      version: $version,
      created_at: $created_at,
      backup_dir: $backup_dir,
      files: $files
    }' >"$manifest"
}

# --- Scaffolds to recreate ---

scaffolds_tasks='{"version":2,"tasks":{}}'
scaffolds_reviewed='{"version":1,"reviewed":[]}'

# --- Dry-run output ---

if [[ "$mode" == "dry-run" ]]; then
  if $json_output; then
    jq -n \
      --arg mode "dry-run" \
      --arg backup_dir "$backup_dir" \
      --arg tasks_file "${tasks_file:-(not found)}" \
      --argjson tasks_found "$tasks_found" \
      --arg reviewed_file "$reviewed_file" \
      --argjson reviewed_exists "$([ -f "$reviewed_file" ] && echo true || echo false)" \
      --arg pending_dir "$pending_dir" \
      --argjson pending_top "$pending_top_count" \
      --argjson pending_reviewed "$pending_reviewed_count" \
      --argjson pending_quarantined "$pending_quarantined_count" \
      --argjson pending_total "$pending_total" \
      --argjson stream_count "${#stream_files[@]}" \
      --argjson include_streams "$include_streams" \
      --argjson running_count "$running_count" \
      --argjson force_running "$force_running" \
      '{
        mode: $mode,
        backup_dir: $backup_dir,
        running_count: $running_count,
        force_running: $force_running,
        would_move: {
          tasks_file: (if $tasks_found then $tasks_file else null end),
          reviewed_file: (if $reviewed_exists then $reviewed_file else null end),
          pending_review: {
            dir: $pending_dir,
            active: $pending_top,
            reviewed: $pending_reviewed,
            quarantined: $pending_quarantined,
            total: $pending_total
          },
          streams: { count: $stream_count, included: $include_streams }
        },
        would_recreate: {
          tasks_file: (if $tasks_found then $tasks_file else null end),
          reviewed_file: $reviewed_file
        }
      }'
  else
    echo "Fresh Slate Reset (DRY RUN)"
    echo "============================"
    echo ""
    echo "Backup directory: $backup_dir"
    echo ""

    if [[ "$running_count" -gt 0 ]]; then
      echo "WARNING: $running_count running task(s) detected (--force-running is set)"
      echo ""
    fi

    echo "Files to back up:"
    if $tasks_found; then
      local_total=$(jq '[.tasks // {} | to_entries[]] | length' "$tasks_file" 2>/dev/null || echo 0)
      echo "  $tasks_file ($local_total tasks, $running_count running)"
    else
      echo "  (no tasks.json found)"
    fi
    if [[ -f "$reviewed_file" ]]; then
      local_reviewed=$(jq '[.reviewed // [] | .[]] | length' "$reviewed_file" 2>/dev/null || echo 0)
      echo "  $reviewed_file ($local_reviewed entries)"
    else
      echo "  (no reviewed-tasks.json found)"
    fi
    echo "  $pending_dir/ ($pending_total total: $pending_top_count active, $pending_reviewed_count reviewed, $pending_quarantined_count quarantined)"
    if $include_streams; then
      echo "  /tmp/*-stream-*.jsonl (${#stream_files[@]} files)"
    fi
    echo ""
    echo "Files to recreate:"
    if $tasks_found; then
      echo "  $tasks_file -> $scaffolds_tasks"
    fi
    echo "  $reviewed_file -> $scaffolds_reviewed"
    echo ""
    echo "Pass --apply to execute."
  fi
  exit 0
fi

# --- Apply ---

# Ensure lock is released on exit (lock is acquired below, only when tasks_file exists)
trap 'unlock_tasks' EXIT

# Prepare backup root (parent must exist for mkdir below)
mkdir -p "$backup_root"

moved_count=0

# --- Mutate tasks.json under launcher lock ---

if $tasks_found && [[ -f "$tasks_file" ]]; then
  if ! lock_tasks "$tasks_file"; then
    echo "error: could not acquire tasks.json lock — another process holds it" >&2
    exit 1
  fi

  # Re-check running tasks under lock (the pre-lock check may be stale)
  locked_running=0
  if [[ -f "$tasks_file" && -s "$tasks_file" ]]; then
    locked_running=$(jq '[.tasks // {} | to_entries[] | select(.value.status == "running")] | length' "$tasks_file" 2>/dev/null || echo 0)
  fi
  if [[ "$locked_running" -gt 0 ]] && ! $force_running; then
    unlock_tasks
    if $json_output; then
      jq -n \
        --argjson running_count "$locked_running" \
        --arg tasks_file "$tasks_file" \
        '{
          error: "running_tasks_detected",
          message: "Refusing reset: \($running_count) running task(s) detected under lock in \($tasks_file). Use --force-running to override.",
          running_count: $running_count,
          tasks_file: $tasks_file
        }'
    else
      echo "error: $locked_running running task(s) detected in $tasks_file (checked under lock)" >&2
      echo "Refusing to reset while tasks are running." >&2
      echo "Use --force-running to override (will NOT kill running agents)." >&2
    fi
    exit 1
  fi
fi

# Create backup dir only after all refusal checks pass.
# If it already exists (same-second rerun), append a random suffix.
if [[ -e "$backup_dir" ]]; then
  backup_dir="${backup_dir}-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
fi
mkdir "$backup_dir"

# Receipt before mutation: record path + sha256 + size of every file about
# to be moved. Written while the tasks.json lock is still held, so the
# manifest cannot drift from what actually gets backed up.
write_manifest

# --- Move tasks.json (lock is still held from above) ---

if $tasks_found && [[ -f "$tasks_file" ]]; then
  mv "$tasks_file" "$backup_dir/tasks.json"
  moved_count=$((moved_count + 1))

  tasks_dir=$(dirname "$tasks_file")
  mkdir -p "$tasks_dir"
  echo "$scaffolds_tasks" > "$tasks_file"

  unlock_tasks
fi

# --- Move reviewed-tasks.json ---

if [[ -f "$reviewed_file" ]]; then
  mv "$reviewed_file" "$backup_dir/reviewed-tasks.json"
  moved_count=$((moved_count + 1))
fi

# --- Move full pending-review store (including reviewed/ and quarantined/) ---
# Atomic: rename the directory, then recreate the empty parent.
# If the rename fails, abort rather than leaving partial state.

if [[ -d "$pending_dir" ]] && [[ "$pending_total" -gt 0 ]]; then
  mv "$pending_dir" "$backup_dir/pending-review"
  moved_count=$((moved_count + pending_total))
  # Recreate the empty pending-review directory so the launcher can keep writing
  mkdir -p "$pending_dir"
fi

# --- Move stream files ---

if $include_streams && [[ ${#stream_files[@]} -gt 0 ]]; then
  mkdir -p "$backup_dir/streams"
  for f in "${stream_files[@]}"; do
    mv "$f" "$backup_dir/streams/"
    moved_count=$((moved_count + 1))
  done
fi

# --- Recreate remaining scaffolds ---

recreated_count=0

if $tasks_found; then
  # tasks.json was already recreated under lock above
  recreated_count=$((recreated_count + 1))
fi

reviewed_dir=$(dirname "$reviewed_file")
mkdir -p "$reviewed_dir"
echo "$scaffolds_reviewed" > "$reviewed_file"
recreated_count=$((recreated_count + 1))

# --- Post-reset verification ---

post_tasks_total=0
if $tasks_found && [[ -f "$tasks_file" ]]; then
  post_tasks_total=$(jq '[.tasks // {} | to_entries[]] | length' "$tasks_file" 2>/dev/null || echo 0)
fi
post_reviewed_count=0
if [[ -f "$reviewed_file" ]]; then
  post_reviewed_count=$(jq '[.reviewed // [] | .[]] | length' "$reviewed_file" 2>/dev/null || echo 0)
fi
post_pending_count=0
if [[ -d "$pending_dir" ]]; then
  post_pending_count=$(find "$pending_dir" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ') || true
fi

# --- Output ---

if $json_output; then
  jq -n \
    --arg mode "apply" \
    --arg backup_dir "$backup_dir" \
    --argjson moved_count "$moved_count" \
    --argjson recreated_count "$recreated_count" \
    --argjson post_tasks "$post_tasks_total" \
    --argjson post_reviewed "$post_reviewed_count" \
    --argjson post_pending "$post_pending_count" \
    '{
      mode: $mode,
      backup_dir: $backup_dir,
      manifest: "\($backup_dir)/manifest.json",
      moved_count: $moved_count,
      recreated_count: $recreated_count,
      post_reset: {
        tasks: $post_tasks,
        reviewed: $post_reviewed,
        pending_review: $post_pending
      },
      rollback: "To restore, move files from \($backup_dir) back to their original locations."
    }'
else
  echo "Fresh Slate Reset (APPLIED)"
  echo "============================"
  echo ""
  echo "Backup: $backup_dir"
  echo "  Manifest: $backup_dir/manifest.json"
  echo "  Moved: $moved_count file(s)"
  echo "  Recreated: $recreated_count scaffold(s)"
  echo ""
  echo "Post-reset state:"
  echo "  Tasks: $post_tasks_total"
  echo "  Reviewed: $post_reviewed_count"
  echo "  Pending review: $post_pending_count"
  echo ""
  echo "Rollback: move files from $backup_dir back to their original locations."
  echo ""
  echo "Note: Live discovery may still populate Agent Status. Disable"
  echo "commandCentral.discovery.enabled through VS Code Settings or an"
  echo "extension command that uses the VS Code configuration API, then"
  echo "reload the window."
fi
