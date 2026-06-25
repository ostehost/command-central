#!/bin/bash
#
# completion-artifacts.sh — Locate, stage, and parse completion artifacts
#
# Extracted from oste-complete.sh. Pure utilities (no dynamic-scope write
# contracts, no caller-local mutation) for locating handoff artifacts and
# .oste-report.yaml completion reports, staging/merging reports into the
# pending-review record, and low-level epoch/marker parsing shared by the
# completion and reconciliation paths.
#
# Public API:
#   _completion_report_task_id <report_file>        -> declared task_id (best effort)
#   find_completion_report_file <project_dir> <task_id>  -> per-task/shared .oste-report.yaml
#       (runtime cwd hint read from OSTE_COMPLETION_CWD)
#   _completion_artifact_fresh <path> <started_at>  -> 0 if artifact mtime >= started_at
#   resolve_completion_artifact_path <artifact> <project_dir> <started_at>
#       (runtime cwd hint read from OSTE_COMPLETION_CWD)
#   stage_completion_report_for_ingestion <task_id> <project_dir>  -> staged temp path
#   merge_completion_report_into_pending <staged_report> <pending_file> <task_id>
#   _reconcile_iso_to_epoch <iso8601>               -> unix epoch
#   _reconcile_file_mtime_epoch <path>              -> file mtime epoch
#   _reconcile_marker_field <marker> <field>        -> marker key=value lookup
#
# Host contract:
#   - Globals from the host: TASKS_FILE, SCRIPT_DIR (merge helper path);
#     env OSTE_COMPLETION_CWD is read opportunistically.
#   - merge_completion_report_into_pending shells out to
#     ${SCRIPT_DIR}/lib/merge-completion-report.py.

# Guard against double-sourcing
[[ -n "${_COMPLETION_ARTIFACTS_SH_LOADED:-}" ]] && return 0
readonly _COMPLETION_ARTIFACTS_SH_LOADED=1

# ── Low-level epoch / marker parsing utilities ──────────────────────────
_reconcile_iso_to_epoch() {
	local value="${1:-}"
	[[ -n "$value" && "$value" != "null" ]] || return 1
	date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$value" +%s 2>/dev/null ||
		date -u -d "$value" +%s 2>/dev/null
}

_reconcile_file_mtime_epoch() {
	local path="${1:-}"
	[[ -n "$path" && -e "$path" ]] || return 1
	stat -f %m "$path" 2>/dev/null || stat -c %Y "$path" 2>/dev/null
}

_reconcile_marker_field() {
	local marker="$1"
	local field="$2"
	grep "^${field}=" "$marker" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# ── Completion report + handoff artifact resolution ────────────────────
# Read the declared task_id from a .oste-report.yaml-shaped file (best effort).
# Mirrors oste-stop-hook.sh:_report_field for the task_id key only. Prints empty
# when the file is unreadable or declares no task_id.
_completion_report_task_id() {
	local report_file="$1"
	[[ -f "$report_file" ]] || return 0
	local line value
	line=$(grep -E "^[[:space:]]*task_id:" "$report_file" 2>/dev/null | head -1 || true)
	[[ -n "$line" ]] || return 0
	value="${line#*:}"
	value="${value#"${value%%[![:space:]]*}"}"
	value="${value%"${value##*[![:space:]]}"}"
	value="${value%\"}"
	value="${value#\"}"
	value="${value%'}"
	value="${value#'}"
	printf '%s' "$value"
}

find_completion_report_file() {
	local project_dir="${1:-}"
	local task_id="${2:-}"
	local cwd_hint="${OSTE_COMPLETION_CWD:-}"

	# Prefer the runtime cwd when provided by the Stop hook. Some visible lanes
	# reuse a canonical launcher project identity but do the actual work in a
	# target worktree; their report lives in that worktree, not in the canonical
	# project_dir recorded for the launcher bundle.
	#
	# Provenance gate: per-task .oste-report.<task_id>.yaml wins. The legacy shared
	# .oste-report.yaml is accepted only when it declares no task_id or the SAME
	# task_id; a foreign shared report is left in place for its owning lane.
	for dir in "$cwd_hint" "$project_dir" "."; do
		[[ -n "$dir" ]] || continue
		if [[ -n "$task_id" && -f "${dir}/.oste-report.${task_id}.yaml" ]]; then
			echo "${dir}/.oste-report.${task_id}.yaml"
			return 0
		fi
		local shared_file="${dir}/.oste-report.yaml"
		if [[ -f "$shared_file" ]]; then
			local report_tid
			report_tid=$(_completion_report_task_id "$shared_file")
			if [[ -z "$report_tid" || -z "$task_id" || "$report_tid" == "$task_id" ]]; then
				echo "$shared_file"
				return 0
			fi
			echo "find_completion_report_file: skipping foreign report ${shared_file} (declares task_id=${report_tid}, expected ${task_id})" >&2
		fi
	done
}

# _completion_artifact_fresh <path> <started_at_iso> — true unless the file's
# mtime is provably older than started_at (a stale prior-run artifact). An
# empty or unparseable started_at means "no guard" (treat as fresh) so an
# unreadable timestamp never manufactures a false contract_failure.
_completion_artifact_fresh() {
	local path="$1"
	local started_at="${2:-}"
	[[ -n "$started_at" && "$started_at" != "null" ]] || return 0
	local start_epoch artifact_epoch
	start_epoch=$(_reconcile_iso_to_epoch "$started_at" 2>/dev/null) || return 0
	artifact_epoch=$(_reconcile_file_mtime_epoch "$path" 2>/dev/null) || return 0
	[[ "$artifact_epoch" -ge "$start_epoch" ]]
}

resolve_completion_artifact_path() {
	local artifact="${1:-}"
	local project_dir="${2:-}"
	local started_at="${3:-}"
	local cwd_hint="${OSTE_COMPLETION_CWD:-}"
	[[ -n "$artifact" && "$artifact" != "null" ]] || return 1
	case "$artifact" in
		/*)
			printf '%s
' "$artifact"
			return 0
			;;
	esac

	for dir in "$cwd_hint" "$project_dir" "."; do
		[[ -n "$dir" ]] || continue
		[[ -s "${dir}/${artifact}" ]] || continue
		# project_dir keeps the long-standing unguarded behavior; cwd_hint and "."
		# are broader target-worktree search surfaces, so require the started_at
		# freshness guard there to avoid accepting a stale prior-run handoff that
		# would silently paper over a real contract_failure.
		[[ "$dir" == "$project_dir" ]] || _completion_artifact_fresh "${dir}/${artifact}" "$started_at" || continue
		printf '%s
' "${dir}/${artifact}"
		return 0
	done

	# Preserve the old canonical fallback for diagnostics when the artifact is
	# still missing.
	if [[ -n "$project_dir" ]]; then
		printf '%s
' "${project_dir}/${artifact}"
	else
		printf '%s
' "$artifact"
	fi
}

stage_completion_report_for_ingestion() {
	local task_id="$1"
	local project_dir="${2:-}"
	local report_file=""
	report_file=$(find_completion_report_file "$project_dir" "$task_id")
	[[ -n "$report_file" ]] || return 1

	local staged_report
	staged_report=$(mktemp "/tmp/oste-report-${task_id}.XXXXXX.yaml")
	if mv "$report_file" "$staged_report" 2>/dev/null; then
		echo "$staged_report"
		return 0
	fi

	rm -f "$staged_report"
	return 1
}

merge_completion_report_into_pending() {
	local staged_report_file="$1"
	local pending_file="$2"
	local task_id="$3"

	[[ -n "$staged_report_file" && -f "$staged_report_file" && -f "$pending_file" ]] || return 1

	local tmp_pending
	tmp_pending=$(mktemp)
	if python3 "${SCRIPT_DIR}/lib/merge-completion-report.py" \
		"$staged_report_file" "$pending_file" "$tmp_pending" "$task_id" 2>/dev/null; then
		mv "$tmp_pending" "$pending_file"
		rm -f "$staged_report_file"
		return 0
	fi

	rm -f "$tmp_pending"
	return 1
}
