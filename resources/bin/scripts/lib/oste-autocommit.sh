#!/bin/bash
#
# oste-autocommit.sh — Scoped auto-commit of agent-owned work
#
# Extracted from oste-complete.sh. Stages and commits only the files a task can
# prove ownership of (via tasks.json dirty_baseline hashing), leaving preexisting
# baseline dirt for whichever lane was already editing it. Classifies any residual
# dirt and finalizes git identity / commit metadata.
#
# Public API:
#   attempt_scoped_auto_commit <project_dir> <task_id> <commit_msg>
#       -> stdout "committed" | "no_owned" | "commit_failed"; 0 on committed.
#   _complete_autocommit_and_classify_dirt <task_id> <exit_code> <project_dir> <now> <marker>
#   _finalize_git_identity_and_commit_metadata <task_id> <project_dir>
#
# Host contract (bash dynamic scoping carries these across the source boundary):
#   - Globals set by the host: TASKS_FILE.
#   - Requires _tasks_json_apply (jq-apply-to-TASKS_FILE primitive) from
#     tasks-lock.sh, which the host sources before this lib.
#   - _complete_autocommit_and_classify_dirt REVISES main()'s locals (assigned
#     WITHOUT `local`): status, auto_committed, dirty_reason. Caller pre-declares.
#   - _finalize_git_identity_and_commit_metadata REVISES main()'s locals:
#     end_commit, actual_model. Caller pre-declares.
#   - Both run inside the caller's held tasks lock — they must NOT re-lock.

# Guard against double-sourcing
[[ -n "${_OSTE_AUTOCOMMIT_SH_LOADED:-}" ]] && return 0
readonly _OSTE_AUTOCOMMIT_SH_LOADED=1

# Scoped auto-commit guard: only stage and commit files that this task can be
# proven to own, leaving any pre-existing baseline dirt for whichever lane was
# already editing it before this task started.
#
# Ownership rule (hash-based):
#   • Path NOT in tasks.json[$task_id].dirty_baseline                 → OWNED
#   • Path in baseline + current content hash differs from baseline   → OWNED
#     (provable post-spawn modification by this task)
#   • Path in baseline + current content hash matches baseline        → SKIP
#     (untouched preexisting dirt; another lane's work)
#
# When dirty_baseline is absent or empty (clean-start tasks) every dirty path
# is OWNED — preserves the legacy `git add -A` behavior for non-dirty spawns.
#
# Args:
#   $1 project_dir
#   $2 task_id
#   $3 commit message
# Stdout: one of "committed", "no_owned" (only baseline-preserved dirt
#         remained), or "commit_failed" (staging or commit returned non-zero).
# Returns 0 on "committed", 1 otherwise.
attempt_scoped_auto_commit() {
	local project_dir="$1"
	local task_id="$2"
	local commit_msg="$3"

	local porcelain
	porcelain=$(git -C "$project_dir" status --porcelain 2>/dev/null || true)
	if [[ -z "$porcelain" ]]; then
		echo "no_owned"
		return 1
	fi

	local baseline_json="[]"
	if [[ -f "$TASKS_FILE" ]]; then
		baseline_json=$(jq -c --arg id "$task_id" '.tasks[$id].dirty_baseline // []' "$TASKS_FILE" 2>/dev/null || echo '[]')
	fi
	[[ -z "$baseline_json" || "$baseline_json" == "null" ]] && baseline_json='[]'

	local -a owned=()
	local line path_part current_hash lookup
	while IFS= read -r line; do
		[[ -z "$line" ]] && continue
		path_part="${line:3}"
		if [[ "$path_part" == *" -> "* ]]; then
			path_part="${path_part##* -> }"
		fi
		if [[ "$path_part" == \"*\" ]]; then
			path_part=$(printf '%b' "${path_part:1:-1}")
		fi

		current_hash="null"
		if [[ -f "${project_dir}/${path_part}" ]]; then
			local h
			h=$(git -C "$project_dir" hash-object -- "$path_part" 2>/dev/null || true)
			[[ -n "$h" ]] && current_hash="$h"
		fi

		# Look up baseline entry. "absent" → not in baseline, "null" → baseline
		# recorded a missing/deleted file, otherwise the recorded hash string.
		lookup=$(jq -r --arg p "$path_part" '
			([.[] | select(.path == $p)] | first) as $entry
			| if $entry == null then "absent"
			  elif ($entry.hash // null) == null then "null"
			  else $entry.hash end
		' <<<"$baseline_json" 2>/dev/null || echo "absent")

		if [[ "$lookup" == "absent" ]]; then
			owned+=("$path_part")
		elif [[ "$lookup" == "$current_hash" ]]; then
			: # baseline-preserved (provably untouched), skip
		else
			owned+=("$path_part")
		fi
	done <<<"$porcelain"

	if [[ ${#owned[@]} -eq 0 ]]; then
		echo "no_owned"
		return 1
	fi

	if GIT_AUTHOR_NAME="Oste Agent" GIT_AUTHOR_EMAIL="oste@agent.local" \
		GIT_COMMITTER_NAME="Oste Agent" GIT_COMMITTER_EMAIL="oste@agent.local" \
		git -C "$project_dir" -c core.hooksPath=/dev/null add -- "${owned[@]}" >/dev/null 2>&1 &&
		GIT_AUTHOR_NAME="Oste Agent" GIT_AUTHOR_EMAIL="oste@agent.local" \
			GIT_COMMITTER_NAME="Oste Agent" GIT_COMMITTER_EMAIL="oste@agent.local" \
			git -C "$project_dir" -c core.hooksPath=/dev/null commit --no-verify --no-gpg-sign -m "$commit_msg" >/dev/null 2>&1; then
		echo "committed"
		return 0
	fi

	echo "commit_failed"
	return 1
}

# Step 3a: scoped auto-commit of agent-owned work, then classify any residual dirt.
# REVISES SHARED COMPLETION STATE via dynamic scope (assigned WITHOUT `local`):
# status (may become completed_dirty), auto_committed, dirty_reason. The caller
# MUST pre-declare all three `local` before calling so the writes land in main()'s
# scope. Reviewer lanes and clean trees are no-ops. Runs inside the caller's tasks
# lock — must not re-lock.
# shellcheck disable=SC2154  # status/auto_committed/dirty_reason are main()'s locals (see header)
_complete_autocommit_and_classify_dirt() {
	local task_id="$1" exit_code="$2" project_dir="$3" now="$4" marker="$5"
	local task_role_post=""
	task_role_post=$(jq -r --arg id "$task_id" '.tasks[$id].role // empty' "$TASKS_FILE" 2>/dev/null || true)
	if [[ "$task_role_post" == "reviewer" ]]; then
		: # Review tasks: no auto-commit (handled by pre-guard skip above)
	elif [[ "$status" == "completed" && -n "$project_dir" && -d "$project_dir" ]]; then
		local porcelain
		porcelain=$(git -C "$project_dir" status --porcelain 2>/dev/null || true)
		if [[ -n "$porcelain" ]]; then
			# Scoped auto-commit: only stage files this task can prove ownership
			# of via dirty_baseline. Files dirty before spawn AND still untouched
			# (hash matches) are preserved for whichever lane was editing them.
			local auto_commit_msg="chore: auto-commit agent work [${task_id}]"
			local first_result
			first_result=$(attempt_scoped_auto_commit "$project_dir" "$task_id" "$auto_commit_msg" 2>/dev/null || true)
			case "$first_result" in
				committed)
					auto_committed=true
					# Second pass: lint/format hooks may have reformatted the
					# just-committed files; re-run the scoped commit to capture
					# them (baseline files stay excluded on every pass).
					local second_result
					second_result=$(attempt_scoped_auto_commit "$project_dir" "$task_id" \
						"chore: stage lint-reformatted files" 2>/dev/null || true)
					if [[ "$second_result" == "committed" ]]; then
						echo "Second-pass auto-commit: staged lint-reformatted files" >&2
					fi
					;;
				no_owned)
					echo "Auto-commit skipped: no owned changes (dirty_baseline preserves preexisting files for ${task_id})" >&2
					;;
				commit_failed | *)
					: # Tracked below via final tree-state check.
					;;
			esac

			# Final clean-tree assertion: classify the residual dirt to choose
			# the correct dirty_reason for downstream consumers.
			local final_porcelain
			final_porcelain=$(git -C "$project_dir" status --porcelain 2>/dev/null || true)
			if [[ -n "$final_porcelain" ]]; then
				if [[ "$auto_committed" == true || "$first_result" == "no_owned" ]]; then
					# Either we already committed everything we could prove
					# ownership of, or there was nothing to own — the residual
					# dirt is preexisting baseline state another lane owns.
					dirty_reason="baseline_preserved"
					echo "Tree still dirty after scoped auto-commit (baseline preserved):" >&2
				else
					dirty_reason="auto_commit_failed"
					echo "Warning: tree still dirty after scoped auto-commit (commit attempt failed):" >&2
				fi
				echo "$final_porcelain" >&2
				status="completed_dirty"
				# Update marker and tasks.json with corrected status + reason
				cat >"$marker" <<-DMARKER
					status=${status}
					exit_code=${exit_code}
					completed_at=${now}
					task_id=${task_id}
					has_uncommitted=true
					dirty_reason=${dirty_reason}
				DMARKER
				_tasks_json_apply --arg id "$task_id" --arg status "$status" --arg reason "$dirty_reason" \
					'.tasks[$id].status = $status |
					 .tasks[$id].has_uncommitted = true |
					 .tasks[$id].dirty_reason = $reason' || true
			fi
		fi
	fi
}

# Step 3a-post/end/end2: restore git identity, capture end_commit/manager_commit
# (HEAD after any auto-commits), and record actual_model from the stream file.
# REVISES SHARED STATE via dynamic scope (no `local`): end_commit, actual_model
# (both read later by pending-review + callback). Caller pre-declares both local.
# shellcheck disable=SC2154  # end_commit/actual_model are main()'s locals (see header)
_finalize_git_identity_and_commit_metadata() {
	local task_id="$1" project_dir="$2"
	# Restore git identity (unset agent-specific config, fall back to global)
	if [[ -n "$project_dir" && -d "$project_dir" ]]; then
		git -C "$project_dir" config --unset user.name 2>/dev/null || true
		git -C "$project_dir" config --unset user.email 2>/dev/null || true
	fi
	# Capture end_commit / manager_commit (HEAD after any auto-commits); preserve
	# legacy end_commit for completion consumers that still read it.
	end_commit="unknown"
	if [[ -n "$project_dir" && -d "$project_dir" ]]; then
		end_commit=$(git -C "$project_dir" rev-parse HEAD 2>/dev/null || echo "unknown")
	fi
	_tasks_json_apply --arg id "$task_id" --arg end_commit "$end_commit" \
		'.tasks[$id].end_commit = $end_commit |
		.tasks[$id].manager_commit = $end_commit' || true
	# Parse actual_model from the stream file and record it.
	actual_model=""
	local stream_file=""
	stream_file=$(jq -r --arg id "$task_id" '.tasks[$id].stream_file // empty' "$TASKS_FILE" 2>/dev/null || true)
	if [[ -n "$stream_file" && -f "$stream_file" ]]; then
		actual_model=$(head -1 "$stream_file" | jq -r '.model // empty' 2>/dev/null || true)
	fi
	if [[ -n "$actual_model" ]]; then
		_tasks_json_apply --arg id "$task_id" --arg actual_model "$actual_model" \
			'.tasks[$id].actual_model = $actual_model' || true
	fi
}
