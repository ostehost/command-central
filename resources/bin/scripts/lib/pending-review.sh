#!/bin/bash
#
# pending-review.sh — Library for managing pending review files
#
# Pending reviews are ephemeral JSON files written by oste-complete.sh
# so that the main agent's cron loop can detect unreviewed completions
# and act on them (review, report, spawn next task).
#
# Directory: /tmp/oste-pending-review/ (or OSTE_PENDING_REVIEW_DIR override)
#

# Directory where pending review files are stored. Allow callers to predefine
# this as readonly before sourcing the library.
if [[ -z "${PENDING_REVIEW_DIR+x}" ]]; then
	PENDING_REVIEW_DIR="${OSTE_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}"
fi

# Shared review-gate verdict-marker writer (PAR-290 / LANE-HOOK-02). Sourced
# DEFENSIVELY: a missing/broken lib must never break the review pipeline, so a
# failed source is swallowed and the emit calls below are command-guarded.
if [[ -z "${__OSTE_REVIEW_VERDICT_SH:-}" ]]; then
	# shellcheck source=review-verdict.sh
	source "$(dirname "${BASH_SOURCE[0]}")/review-verdict.sh" 2>/dev/null || true
fi

# TaskCompleted-time snapshot path for canonical review metadata.
pending_review_snapshot_file() {
	local task_id="$1"
	echo "/tmp/oste-task-complete-metadata-${task_id}.json"
}

# Ensure the pending review directory exists
pending_review_init() {
	mkdir -p "$PENDING_REVIEW_DIR"
}

pending_review_commit_exists() {
	local project_dir="$1"
	local commit="$2"

	[[ -n "$project_dir" && -n "$commit" ]] || return 1
	git -C "$project_dir" cat-file -e "${commit}^{commit}" >/dev/null 2>&1
}

pending_review_normalize_files_json() {
	jq -c '((. // []) | map(select(type == "string" and length > 0 and . != ".oste-report.yaml")) | unique | sort)' 2>/dev/null
}

# Peel handoff-only commits off a head_commit to find the implementation commit.
#
# Walks commits in start_sha..head_commit from newest to oldest. A commit is
# considered "handoff-only" (lifecycle-only) when every file it touches is in
# the lifecycle set:
#   - the declared handoff_file (project-relative path), and/or
#   - .oste-report.yaml
#
# Stops at the first commit that touches a non-lifecycle file and returns
# that commit as the implementation pin. If every commit in the range is
# lifecycle-only the handoff IS the task's actual deliverable, so the
# original head_commit is returned unchanged. With an empty/missing
# start_sha or head_commit the function falls back to head_commit so callers
# never get an empty result.
#
# This lets review metadata (agent_commit, review_end_commit, files_changed)
# stay pinned to the implementation commit when oste-complete.sh later
# safety-net-auto-commits the handoff file (or when the agent itself made a
# trailing handoff/docs commit). manager_commit and the legacy tasks.json
# end_commit still record the final HEAD, so the post-handoff repository
# state is preserved separately.
#
# Args: $1 project_dir, $2 start_sha, $3 head_commit, $4 handoff_file (optional)
# Stdout: the pinned implementation commit SHA (or head_commit on fallback)
peel_handoff_only_commits() {
	local project_dir="$1"
	local start_sha="${2:-}"
	local head_commit="${3:-}"
	local handoff_file="${4:-}"

	[[ -n "$project_dir" && -d "$project_dir" ]] || {
		echo "$head_commit"
		return 0
	}
	[[ -n "$head_commit" ]] || {
		echo ""
		return 0
	}
	pending_review_commit_exists "$project_dir" "$head_commit" || {
		echo "$head_commit"
		return 0
	}

	# Normalize an absolute handoff_file to project-relative so it lines up
	# with git's repo-root-relative path output.
	if [[ "$handoff_file" == /* ]]; then
		case "$handoff_file" in
			"${project_dir}"/*) handoff_file="${handoff_file#"${project_dir}"/}" ;;
		esac
	fi

	local commits=""
	if [[ -n "$start_sha" ]] && pending_review_commit_exists "$project_dir" "$start_sha"; then
		commits=$(git -C "$project_dir" rev-list "${start_sha}..${head_commit}" 2>/dev/null || true)
	fi
	# No range to walk → no peeling possible.
	[[ -n "$commits" ]] || {
		echo "$head_commit"
		return 0
	}

	local pinned="$head_commit"
	local found_impl=false
	local commit files all_lifecycle f parent
	while IFS= read -r commit; do
		[[ -z "$commit" ]] && continue
		files=$(git -C "$project_dir" show --pretty='' --name-only "$commit" 2>/dev/null || true)
		all_lifecycle=true
		if [[ -n "$files" ]]; then
			while IFS= read -r f; do
				[[ -z "$f" ]] && continue
				if [[ "$f" == ".oste-report.yaml" ]]; then continue; fi
				if [[ -n "$handoff_file" && "$f" == "$handoff_file" ]]; then continue; fi
				all_lifecycle=false
				break
			done <<<"$files"
		fi
		if [[ "$all_lifecycle" == "true" ]]; then
			parent=$(git -C "$project_dir" rev-parse "${commit}^" 2>/dev/null || true)
			if [[ -n "$parent" ]]; then
				pinned="$parent"
			fi
			continue
		fi
		# Non-lifecycle commit: this is the implementation pin.
		pinned="$commit"
		found_impl=true
		break
	done <<<"$commits"

	# Every commit in range was lifecycle-only → the handoff is the
	# deliverable. Preserve the original head as agent_commit so files_changed
	# still describes what the task produced.
	if [[ "$found_impl" != "true" ]]; then
		echo "$head_commit"
		return 0
	fi
	echo "$pinned"
}

pending_review_collect_committed_files_json() {
	local project_dir="$1"
	local start_sha="${2:-}"
	local end_commit="${3:-}"

	[[ -n "$project_dir" && -d "$project_dir" ]] || {
		echo '[]'
		return 0
	}

	{
		if [[ -n "$start_sha" && -n "$end_commit" ]] && pending_review_commit_exists "$project_dir" "$start_sha" && pending_review_commit_exists "$project_dir" "$end_commit"; then
			# Validated baseline → precise, provably-this-task attribution.
			git -C "$project_dir" diff --name-only --relative "${start_sha}..${end_commit}" 2>/dev/null || true
		elif [[ -n "$end_commit" ]] && [[ "${OSTE_ATTRIBUTE_HEAD_WITHOUT_BASELINE:-0}" == "1" ]] && pending_review_commit_exists "$project_dir" "$end_commit"; then
			# Provenance-unsafe legacy fallback (opt-in only). Without a validated
			# baseline start_sha we cannot prove HEAD's commit belongs to THIS
			# task; attributing it leaks an UNRELATED task's committed files when
			# HEAD happens to be another lane's commit (symphony/ackwake
			# cross-attribution incident, 2026-06-15). Off by default: emit no
			# committed files when the baseline is missing/invalid. Live
			# working-tree changes are still captured by
			# pending_review_collect_live_files_json, which appends uncommitted,
			# staged, and untracked paths.
			git -C "$project_dir" show --pretty='' --name-only --relative "$end_commit" 2>/dev/null || true
		fi
	} | awk 'NF { print }' | jq -Rcs 'split("\n")[:-1]' | pending_review_normalize_files_json
}

pending_review_collect_live_files_json() {
	local project_dir="$1"
	local start_sha="${2:-}"
	local head_commit="${3:-}"

	[[ -n "$project_dir" && -d "$project_dir" ]] || {
		echo '[]'
		return 0
	}

	{
		pending_review_collect_committed_files_json "$project_dir" "$start_sha" "$head_commit" | jq -r '.[]'
		git -C "$project_dir" diff --name-only --relative 2>/dev/null || true
		git -C "$project_dir" diff --cached --name-only --relative 2>/dev/null || true
		git -C "$project_dir" ls-files --others --exclude-standard 2>/dev/null || true
	} | awk 'NF { print }' | jq -Rcs 'split("\n")[:-1]' | pending_review_normalize_files_json
}

pending_review_capture_completion_snapshot() {
	local task_id="$1"
	local project_dir="$2"
	local start_sha="${3:-}"

	[[ -n "$task_id" && -n "$project_dir" && -d "$project_dir" ]] || return 1
	git -C "$project_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1

	local head_commit=""
	head_commit=$(git -C "$project_dir" rev-parse HEAD 2>/dev/null || true)

	local files_changed_json="[]"
	files_changed_json=$(pending_review_collect_live_files_json "$project_dir" "$start_sha" "$head_commit")

	local snapshot_file
	snapshot_file=$(pending_review_snapshot_file "$task_id")
	local tmp
	tmp=$(mktemp)
	if jq -n \
		--arg task_id "$task_id" \
		--arg project_dir "$project_dir" \
		--arg start_sha "$start_sha" \
		--arg agent_commit "$head_commit" \
		--arg head_commit "$head_commit" \
		--argjson files_changed "$files_changed_json" \
		--arg captured_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
		'{
			task_id: $task_id,
			project_dir: $project_dir,
			start_sha: (if $start_sha == "" then null else $start_sha end),
			agent_commit: (if $agent_commit == "" then null else $agent_commit end),
			head_commit: (if $head_commit == "" then null else $head_commit end),
			files_changed: $files_changed,
			captured_at: $captured_at
		}' >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$snapshot_file"
	else
		rm -f "$tmp"
		return 1
	fi
}

# Refresh a pending-review receipt from a TaskCompleted snapshot just before
# review dispatch. This covers team/delegate lanes where an early parent Stop
# can write stale pending-review commit metadata, then a later TaskCompleted
# hook captures the actual agent-produced HEAD before review wakes up.
#
# Safety guard: only fast-forward stale/empty pending metadata to a snapshot
# commit that exists in the same repo and descends from the existing pending
# commit when one is present. This avoids silently reviewing unrelated future
# work from the live branch.
#
# Usage: pending_review_refresh_from_completion_snapshot <task_id>
pending_review_refresh_from_completion_snapshot() {
	local task_id="$1"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"
	local snapshot_file=""
	snapshot_file=$(pending_review_snapshot_file "$task_id")

	[[ -f "$file" && -f "$snapshot_file" ]] || return 1

	local project_dir=""
	project_dir=$(jq -r '.project_dir // empty' "$snapshot_file" 2>/dev/null || true)
	if [[ -z "$project_dir" ]]; then
		project_dir=$(jq -r '.project_path // empty' "$file" 2>/dev/null || true)
	fi
	[[ -n "$project_dir" && -d "$project_dir" ]] || return 1
	git -C "$project_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1

	local snapshot_agent_commit=""
	snapshot_agent_commit=$(jq -r '.agent_commit // .head_commit // empty' "$snapshot_file" 2>/dev/null || true)
	[[ -n "$snapshot_agent_commit" ]] || return 1
	pending_review_commit_exists "$project_dir" "$snapshot_agent_commit" || return 1

	local pending_agent_commit=""
	pending_agent_commit=$(jq -r '.agent_commit // .end_commit // .last_commit // empty' "$file" 2>/dev/null || true)
	if [[ -n "$pending_agent_commit" ]]; then
		pending_review_commit_exists "$project_dir" "$pending_agent_commit" || return 1
		[[ "$pending_agent_commit" != "$snapshot_agent_commit" ]] || return 1
		git -C "$project_dir" merge-base --is-ancestor "$pending_agent_commit" "$snapshot_agent_commit" >/dev/null 2>&1 || return 1
	fi

	local start_sha=""
	start_sha=$(jq -r '.start_sha // empty' "$snapshot_file" 2>/dev/null || true)
	if [[ -z "$start_sha" && -n "${TASKS_FILE:-}" && -f "$TASKS_FILE" ]]; then
		start_sha=$(jq -r --arg id "$task_id" '.tasks[$id].start_sha // .tasks[$id].start_commit // empty' "$TASKS_FILE" 2>/dev/null || true)
	fi
	if [[ -z "$start_sha" ]]; then
		start_sha=$(jq -r '.start_sha // .start_commit // empty' "$file" 2>/dev/null || true)
	fi
	if [[ -n "$start_sha" ]] && ! pending_review_commit_exists "$project_dir" "$start_sha"; then
		start_sha=""
	fi

	local files_changed_json="[]"
	if [[ -n "$start_sha" ]]; then
		files_changed_json=$(pending_review_collect_committed_files_json "$project_dir" "$start_sha" "$snapshot_agent_commit")
	else
		files_changed_json=$(jq -c '.files_changed // []' "$snapshot_file" 2>/dev/null || echo '[]')
		files_changed_json=$(printf '%s\n' "$files_changed_json" | pending_review_normalize_files_json)
	fi

	local last_commit=""
	if [[ -n "$start_sha" ]]; then
		last_commit=$(git -C "$project_dir" rev-list --reverse "${start_sha}..${snapshot_agent_commit}" 2>/dev/null | head -1 || true)
	fi
	if [[ -z "$last_commit" ]]; then
		last_commit="$snapshot_agent_commit"
	fi

	local tmp now
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	tmp=$(mktemp)
	if jq \
		--arg now "$now" \
		--arg last_commit "$last_commit" \
		--arg end_commit "$snapshot_agent_commit" \
		--arg agent_commit "$snapshot_agent_commit" \
		--arg manager_commit "$snapshot_agent_commit" \
		--argjson files_changed "$files_changed_json" \
		'.reconciled = true |
		.reconciled_at = $now |
		.reconciliation_reason = "task_completed_snapshot_at_review_dispatch" |
		.last_commit = $last_commit |
		.end_commit = $end_commit |
		.agent_commit = $agent_commit |
		.manager_commit = $manager_commit |
		.files_changed = (if ($files_changed | type) == "array" and ($files_changed | length) > 0 then $files_changed else .files_changed end)' \
		"$file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$file"
	else
		rm -f "$tmp"
		return 1
	fi
}

# Write a pending review file for a completed task
# Usage: pending_review_write <task_id> <status> <exit_code> <completed_at> [project] [project_path] [last_commit] [agent_summary] [end_commit] [actual_model] [files_changed_json] [agent_commit] [manager_commit]
pending_review_write() {
	local task_id="$1"
	local status="$2"
	local exit_code="$3"
	local completed_at="$4"
	local project="${5:-}"
	local project_path="${6:-}"
	local last_commit="${7:-}"
	local agent_summary="${8:-}"
	local end_commit="${9:-}"
	local actual_model="${10:-}"
	local files_changed_json="${11:-[]}"
	local agent_commit="${12:-}"
	local manager_commit="${13:-}"

	if [[ -z "$agent_commit" && -n "$end_commit" ]]; then
		agent_commit="$end_commit"
	fi
	if [[ -z "$manager_commit" && -n "$end_commit" ]]; then
		manager_commit="$end_commit"
	fi

	pending_review_init

	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	# Build JSON using jq for proper escaping
	jq -n \
		--arg task_id "$task_id" \
		--arg project "$project" \
		--arg project_path "$project_path" \
		--arg status "$status" \
		--arg exit_code "$exit_code" \
		--arg completed_at "$completed_at" \
		--arg last_commit "$last_commit" \
		--arg agent_summary "$agent_summary" \
		--arg end_commit "$end_commit" \
		--arg actual_model "$actual_model" \
		--argjson files_changed "$files_changed_json" \
		--arg agent_commit "$agent_commit" \
		--arg manager_commit "$manager_commit" \
		'{
			task_id: $task_id,
			project: $project,
			project_path: $project_path,
			status: $status,
			exit_code: ($exit_code | tonumber),
			completed_at: $completed_at,
			last_commit: $last_commit,
			end_commit: $end_commit,
			agent_commit: (if $agent_commit == "" then null else $agent_commit end),
			manager_commit: (if $manager_commit == "" then null else $manager_commit end),
			actual_model: (if $actual_model == "" then null else $actual_model end),
			agent_summary: $agent_summary,
			files_changed: (if ($files_changed | length) == 0 then null else $files_changed end),
			review_state: "pending",
			reviewed: false,
			reported_to_user: false
		}' >"$file"
}

# List all pending review files (task IDs)
# Usage: pending_review_list [--unreviewed]
pending_review_list() {
	local filter="${1:-}"

	pending_review_init

	if [[ "$filter" == "--unreviewed" ]]; then
		for f in "${PENDING_REVIEW_DIR}"/*.json; do
			[[ -f "$f" ]] || continue
			local reviewed
			reviewed=$(jq -r '.reviewed' "$f" 2>/dev/null || echo "false")
			if [[ "$reviewed" == "false" ]]; then
				basename "$f" .json
			fi
		done
	else
		for f in "${PENDING_REVIEW_DIR}"/*.json; do
			[[ -f "$f" ]] || continue
			basename "$f" .json
		done
	fi
}

# Read a pending review file
# Usage: pending_review_read <task_id>
pending_review_read() {
	local task_id="$1"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	if [[ -f "$file" ]]; then
		cat "$file"
	else
		return 1
	fi
}

# Mark a pending review as reviewed
# Usage: pending_review_mark_reviewed <task_id>
pending_review_mark_reviewed() {
	local task_id="$1"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	[[ -f "$file" ]] || return 1

	local now tmp
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	tmp=$(mktemp)
	if jq \
		--arg now "$now" \
		'.reviewed = true |
		.review_state = "reviewed" |
		.review_completed_at = $now |
		.review_blocker_count = 0 |
		.retry_disabled = false |
		.retry_disabled_reason = null |
		.retry_disabled_detail = null |
		.retry_disabled_at = null' \
		"$file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$file"
	else
		rm -f "$tmp"
		return 1
	fi

	# PAR-290 / LANE-HOOK-02: emit the authoritative review-gate verdict marker
	# the moment the review lands approved. Command-guarded + fail-open.
	if command -v oste_review_verdict_write >/dev/null 2>&1; then
		oste_review_verdict_write "$task_id" "approved" 0 "" "pending_review_transition" "reviewed" "review_complete"
	fi

	# Snapshot the reviewed payload to reviewed/<task_id>.json so audits
	# (e.g. the autonomy canary at openclaw-autonomy-canary.sh) can see a
	# real archived artifact alongside the active queue entry. The reviewed/
	# subdir is not iterated by the watchdog's top-level glob, so this does
	# not regress the "skip review_state=reviewed" path.
	local archive_dir="${PENDING_REVIEW_DIR}/reviewed"
	mkdir -p "$archive_dir" 2>/dev/null || return 0
	cp "$file" "${archive_dir}/${task_id}.json" 2>/dev/null || return 0
}

# Mark a pending review as awaiting fixup after blockers were found
# Usage: pending_review_mark_fixup_requested <task_id> [review_file] [blocker_count]
pending_review_mark_fixup_requested() {
	local task_id="$1"
	local review_file="${2:-}"
	local blocker_count="${3:-0}"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	[[ -f "$file" ]] || return 1
	[[ "$blocker_count" =~ ^[0-9]+$ ]] || blocker_count="0"

	local now tmp
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	tmp=$(mktemp)
	if jq \
		--arg review_file "$review_file" \
		--arg now "$now" \
		--argjson blocker_count "$blocker_count" \
		'.review_state = "awaiting_fixup" |
		.review_handoff_file = (if $review_file == "" then .review_handoff_file else $review_file end) |
		.review_completed_at = $now |
		.review_blocker_count = $blocker_count |
		.retry_disabled = true |
		.retry_disabled_reason = "awaiting_fixup" |
		.retry_disabled_detail = null |
		.retry_disabled_at = $now' \
		"$file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$file"
	else
		rm -f "$tmp"
		return 1
	fi

	# PAR-290 / LANE-HOOK-02: emit the authoritative review-gate verdict marker
	# the moment the review lands with requested changes. Command-guarded +
	# fail-open.
	if command -v oste_review_verdict_write >/dev/null 2>&1; then
		oste_review_verdict_write "$task_id" "changes_requested" "$blocker_count" "${blocker_count} review blocker(s)" "pending_review_transition" "awaiting_fixup" "review_complete"
	fi
}

# Mark a pending review as reported to user
# Usage: pending_review_mark_reported <task_id>
pending_review_mark_reported() {
	local task_id="$1"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	[[ -f "$file" ]] || return 1

	local tmp
	tmp=$(mktemp)
	if jq '.reported_to_user = true' "$file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$file"
	else
		rm -f "$tmp"
		return 1
	fi
}

pending_review_mark_review_started() {
	local task_id="$1"
	local review_task_id="${2:-}"
	local handoff_file="${3:-}"
	local review_backend="${4:-}"
	local review_mode="${5:-}"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	[[ -f "$file" ]] || return 1

	local now now_epoch tmp
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	now_epoch=$(date -u +%s)
	tmp=$(mktemp)
	if jq \
		--arg review_task_id "$review_task_id" \
		--arg handoff_file "$handoff_file" \
		--arg review_backend "$review_backend" \
		--arg review_mode "$review_mode" \
		--arg now "$now" \
		--argjson now_epoch "$now_epoch" \
		'.review_state = "reviewing" |
		.review_task_id = (if $review_task_id == "" then null else $review_task_id end) |
		.review_handoff_file = (if $handoff_file == "" then null else $handoff_file end) |
		.review_backend = (if $review_backend == "" then null else $review_backend end) |
		.review_mode = (if $review_mode == "" then null else $review_mode end) |
		.review_started_at = $now |
		.review_started_at_epoch = $now_epoch |
		.review_completed_at = null |
		.review_blocker_count = null |
		.review_dispatch_failed = false |
		.review_dispatch_failed_at = null |
		.review_dispatch_failed_reason = null |
		.review_dispatch_failed_detail = null |
		.review_dispatch_failed_log = null |
		.review_dispatch_attempts = ((.review_dispatch_attempts // 0) + 1)' \
		"$file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$file"
	else
		rm -f "$tmp"
		return 1
	fi
}

pending_review_revert_review_started() {
	local task_id="$1"
	local reason="${2:-}"
	local detail="${3:-}"
	local log_path="${4:-}"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	[[ -f "$file" ]] || return 1

	local now tmp
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	tmp=$(mktemp)
	if jq \
		--arg reason "$reason" \
		--arg detail "$detail" \
		--arg log_path "$log_path" \
		--arg now "$now" \
		'.review_state = "pending" |
		.review_dispatch_failed = true |
		.review_dispatch_failed_at = $now |
		.review_dispatch_failed_reason = (if $reason == "" then null else $reason end) |
		.review_dispatch_failed_detail = (if $detail == "" then null else $detail end) |
		.review_dispatch_failed_log = (if $log_path == "" then null else $log_path end)' \
		"$file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$file"
	else
		rm -f "$tmp"
		return 1
	fi
}

pending_review_mark_retry_disabled() {
	local task_id="$1"
	local reason="${2:-}"
	local detail="${3:-}"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	[[ -f "$file" ]] || return 1

	local now tmp
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	tmp=$(mktemp)
	if jq \
		--arg reason "$reason" \
		--arg detail "$detail" \
		--arg now "$now" \
		'.review_state = "blocked" |
		.retry_disabled = true |
		.retry_disabled_reason = (if $reason == "" then null else $reason end) |
		.retry_disabled_detail = (if $detail == "" then null else $detail end) |
		.retry_disabled_at = $now' \
		"$file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$file"
	else
		rm -f "$tmp"
		return 1
	fi

	# PAR-290 / LANE-HOOK-02: emit the authoritative review-gate verdict marker
	# when review retry is disabled (terminal blocked). Command-guarded +
	# fail-open.
	if command -v oste_review_verdict_write >/dev/null 2>&1; then
		oste_review_verdict_write "$task_id" "blocked" 0 "${reason:-retry disabled}" "pending_review_transition" "blocked" "review_complete"
	fi
}

# Mark a pending-review entry reconciled and refresh stale post-handoff metadata.
#
# The marker-state-only flip (status, exit_code, reconciled, reconciliation_reason)
# always runs. When the optional metadata args are supplied, the entry is also
# repaired against the post-handoff truth so a downstream reviewer no longer
# wakes on the stale snapshot that was written at the false contract_failure:
#   - commit fields (last_commit/end_commit/agent_commit/manager_commit) are
#     overwritten when supplied non-empty (originals point at pre-handoff HEAD),
#   - files_changed is overwritten when supplied is a non-empty array
#     (originals can reflect either a stale diff or files leaked from another
#     task in the same workspace),
#   - agent_summary is overwritten when supplied non-empty (the stale value can
#     be leaked from a prior task's last-message file, so a fresh value from
#     the turn that wrote the handoff wins),
#   - routing fields (session_key/callback_url/exec_mode/exec_node) are
#     overwritten when supplied non-empty (task-row-wins semantics; empty
#     means "keep what the entry already has"),
#   - review_state, reviewed, reported_to_user, retry_disabled* are NEVER
#     touched here — a reviewer that already moved the entry to reviewing/
#     reviewed/blocked/awaiting_fixup must not be regressed back to pending.
#
# Usage: pending_review_mark_reconciled <task_id>
#        pending_review_mark_reconciled <task_id> <last_commit> <end_commit> \
#            <agent_commit> <manager_commit> <files_changed_json> \
#            <agent_summary> <session_key> <callback_url> <exec_mode> <exec_node>
pending_review_mark_reconciled() {
	local task_id="$1"
	local refresh_last_commit="${2:-}"
	local refresh_end_commit="${3:-}"
	local refresh_agent_commit="${4:-}"
	local refresh_manager_commit="${5:-}"
	local refresh_files_json="${6:-}"
	local refresh_agent_summary="${7:-}"
	local refresh_session_key="${8:-}"
	local refresh_callback_url="${9:-}"
	local refresh_exec_mode="${10:-}"
	local refresh_exec_node="${11:-}"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	[[ -f "$file" ]] || return 1

	if [[ -z "$refresh_files_json" ]]; then
		refresh_files_json="null"
	fi

	local now tmp
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	tmp=$(mktemp)
	if jq \
		--arg now "$now" \
		--arg last_commit "$refresh_last_commit" \
		--arg end_commit "$refresh_end_commit" \
		--arg agent_commit "$refresh_agent_commit" \
		--arg manager_commit "$refresh_manager_commit" \
		--argjson files_changed "$refresh_files_json" \
		--arg agent_summary "$refresh_agent_summary" \
		--arg session_key "$refresh_session_key" \
		--arg callback_url "$refresh_callback_url" \
		--arg exec_mode "$refresh_exec_mode" \
		--arg exec_node "$refresh_exec_node" \
		'.status = "completed" |
		.exit_code = 0 |
		.reconciled = true |
		.reconciled_at = $now |
		.reconciliation_reason = "late_handoff_artifact" |
		(.last_commit = (if $last_commit == "" then .last_commit else $last_commit end)) |
		(.end_commit = (if $end_commit == "" then .end_commit else $end_commit end)) |
		(.agent_commit = (if $agent_commit == "" then .agent_commit else $agent_commit end)) |
		(.manager_commit = (if $manager_commit == "" then .manager_commit else $manager_commit end)) |
		(.files_changed = (
			if ($files_changed | type) == "array" and ($files_changed | length) > 0
			then $files_changed
			else .files_changed
			end)) |
		(.agent_summary = (if $agent_summary == "" then .agent_summary else $agent_summary end)) |
		(.session_key = (if $session_key == "" then .session_key else $session_key end)) |
		(.callback_url = (if $callback_url == "" then (.callback_url // null) else $callback_url end)) |
		(.exec_mode = (if $exec_mode == "" then (.exec_mode // null) else $exec_mode end)) |
		(.exec_node = (if $exec_node == "" then (.exec_node // null) else $exec_node end))' \
		"$file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$file"
	else
		rm -f "$tmp"
		return 1
	fi
}

pending_review_reconcile_completion() {
	local task_id="$1"
	local target_status="$2"
	local exit_code="$3"
	local reconciliation_reason="$4"
	local refresh_last_commit="${5:-}"
	local refresh_end_commit="${6:-}"
	local refresh_agent_commit="${7:-}"
	local refresh_manager_commit="${8:-}"
	local refresh_files_json="${9:-}"
	local refresh_agent_summary="${10:-}"
	local refresh_session_key="${11:-}"
	local refresh_callback_url="${12:-}"
	local refresh_exec_mode="${13:-}"
	local refresh_exec_node="${14:-}"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	[[ -f "$file" ]] || return 1
	[[ "$exit_code" =~ ^-?[0-9]+$ ]] || return 1

	local review_state reviewed
	review_state=$(jq -r '.review_state // empty' "$file" 2>/dev/null || true)
	reviewed=$(jq -r '.reviewed // false' "$file" 2>/dev/null || echo "false")
	if [[ "$review_state" == "reviewed" && "$reviewed" == "true" && "${OSTE_REPAIR_REVIEWED_PENDING:-0}" != "1" ]]; then
		return 2
	fi

	if [[ -z "$refresh_files_json" ]]; then
		refresh_files_json="null"
	fi
	if ! jq -e . >/dev/null 2>&1 <<<"$refresh_files_json"; then
		refresh_files_json="null"
	fi

	local now tmp
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	tmp=$(mktemp)
	if jq \
		--arg now "$now" \
		--arg target_status "$target_status" \
		--arg exit_code "$exit_code" \
		--arg reconciliation_reason "$reconciliation_reason" \
		--arg last_commit "$refresh_last_commit" \
		--arg end_commit "$refresh_end_commit" \
		--arg agent_commit "$refresh_agent_commit" \
		--arg manager_commit "$refresh_manager_commit" \
		--argjson files_changed "$refresh_files_json" \
		--arg agent_summary "$refresh_agent_summary" \
		--arg session_key "$refresh_session_key" \
		--arg callback_url "$refresh_callback_url" \
		--arg exec_mode "$refresh_exec_mode" \
		--arg exec_node "$refresh_exec_node" \
		'.status = $target_status |
		.exit_code = ($exit_code | tonumber) |
		.reconciled = true |
		.reconciled_at = $now |
		.reconciliation_reason = $reconciliation_reason |
		(.last_commit = (if $last_commit == "" then .last_commit else $last_commit end)) |
		(.end_commit = (if $end_commit == "" then .end_commit else $end_commit end)) |
		(.agent_commit = (if $agent_commit == "" then .agent_commit else $agent_commit end)) |
		(.manager_commit = (if $manager_commit == "" then .manager_commit else $manager_commit end)) |
		(.files_changed = (
			if ($files_changed | type) == "array" and ($files_changed | length) > 0
			then $files_changed
			else .files_changed
			end)) |
		(.agent_summary = (if $agent_summary == "" then .agent_summary else $agent_summary end)) |
		(.session_key = (if $session_key == "" then .session_key else $session_key end)) |
		(.callback_url = (if $callback_url == "" then (.callback_url // null) else $callback_url end)) |
		(.exec_mode = (if $exec_mode == "" then (.exec_mode // null) else $exec_mode end)) |
		(.exec_node = (if $exec_node == "" then (.exec_node // null) else $exec_node end))' \
		"$file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$file"
	else
		rm -f "$tmp"
		return 1
	fi
}

pending_review_review_in_progress_recent() {
	local task_id="$1"
	local cooldown_seconds="${2:-3600}"
	local file="${PENDING_REVIEW_DIR}/${task_id}.json"

	[[ -f "$file" ]] || return 1

	local review_state started_epoch now
	review_state=$(jq -r '.review_state // empty' "$file" 2>/dev/null || true)
	[[ "$review_state" == "reviewing" ]] || return 1

	started_epoch=$(jq -r '.review_started_at_epoch // 0' "$file" 2>/dev/null || echo "0")
	[[ "$started_epoch" =~ ^[0-9]+$ ]] || started_epoch="0"
	[[ "$started_epoch" -gt 0 ]] || return 1

	now=$(date -u +%s)
	[[ $((now - started_epoch)) -lt $cooldown_seconds ]]
}

# Quarantine stale pending-review entries to quarantined/ subdirectory.
# Moves non-terminal entries older than max_age (by completed_at or mtime)
# out of the active queue, annotating them with quarantine metadata.
# Terminal states (reviewed, blocked) are left for normal cleanup.
# Prints the count of quarantined files to stdout.
# Usage: pending_review_quarantine [max_age_seconds]
pending_review_quarantine() {
	local max_age="${1:-21600}" # default 6 hours

	pending_review_init
	mkdir -p "${PENDING_REVIEW_DIR}/quarantined"

	local now quarantined_count=0
	now=$(date +%s)

	for f in "${PENDING_REVIEW_DIR}"/*.json; do
		[[ -f "$f" ]] || continue

		local task_id review_state
		task_id=$(basename "$f" .json)
		review_state=$(jq -r '.review_state // "pending"' "$f" 2>/dev/null || echo "pending")

		case "$review_state" in
			reviewed | blocked | reviewing) continue ;;
		esac

		local completed_at_str file_age_seconds
		completed_at_str=$(jq -r '.completed_at // empty' "$f" 2>/dev/null || true)
		if [[ -n "$completed_at_str" ]]; then
			local completed_epoch
			# Strip trailing Z and parse as UTC (-u) so BSD date doesn't treat
			# the ISO-8601 timestamp as local time.
			completed_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${completed_at_str%Z}" +%s 2>/dev/null || echo "0")
			if [[ "$completed_epoch" -gt 0 ]]; then
				file_age_seconds=$((now - completed_epoch))
			else
				local mtime
				mtime=$(stat -f %m "$f" 2>/dev/null || echo "$now")
				file_age_seconds=$((now - mtime))
			fi
		else
			local mtime
			mtime=$(stat -f %m "$f" 2>/dev/null || echo "$now")
			file_age_seconds=$((now - mtime))
		fi

		if [[ $file_age_seconds -ge $max_age ]]; then
			local quarantine_dest="${PENDING_REVIEW_DIR}/quarantined/${task_id}.json"
			local tmp
			tmp=$(mktemp)
			if jq \
				--arg quarantined_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
				--arg quarantine_reason "stale_age" \
				--argjson age_seconds "$file_age_seconds" \
				'. + {
					quarantined: true,
					quarantined_at: $quarantined_at,
					quarantine_reason: $quarantine_reason,
					quarantine_age_seconds: $age_seconds
				}' "$f" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
				mv "$tmp" "$quarantine_dest"
				rm -f "$f"
			else
				rm -f "$tmp"
				mv "$f" "$quarantine_dest"
			fi
			quarantined_count=$((quarantined_count + 1))
		fi
	done

	echo "$quarantined_count"
}

# Clean up old pending review files (older than given age in seconds)
# Usage: pending_review_cleanup [max_age_seconds]
pending_review_cleanup() {
	local max_age="${1:-86400}" # default 24 hours

	pending_review_init

	local now
	now=$(date +%s)

	for f in "${PENDING_REVIEW_DIR}"/*.json; do
		[[ -f "$f" ]] || continue
		local file_mtime file_age
		file_mtime=$(stat -f %m "$f" 2>/dev/null || echo "$now")
		file_age=$((now - file_mtime))
		if [[ $file_age -ge $max_age ]]; then
			rm -f "$f"
		fi
	done

	# Also clean up quarantined files older than 7 days
	local quarantine_max_age=604800
	if [[ -d "${PENDING_REVIEW_DIR}/quarantined" ]]; then
		for f in "${PENDING_REVIEW_DIR}/quarantined"/*.json; do
			[[ -f "$f" ]] || continue
			local file_mtime file_age
			file_mtime=$(stat -f %m "$f" 2>/dev/null || echo "$now")
			file_age=$((now - file_mtime))
			if [[ $file_age -ge $quarantine_max_age ]]; then
				rm -f "$f"
			fi
		done
	fi
}
