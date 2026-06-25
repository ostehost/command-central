#!/bin/bash
# node-pending-review.sh — Node-aware pending-review/tasks.json fetch helpers
#
# When a launcher task ran on a spoke node (exec_mode=spoke, exec_node=<id>),
# its pending-review JSON, tasks.json row, and handoff artifact live on the
# *node* — not on the hub. Hub-side review consumers must consult these via
# OpenClaw `node_exec` rather than checking hub-local /tmp or hub repo.
#
# Dependencies:
#   - lib/node-exec.sh must be sourced before any helper here is called.
#
# Helpers print JSON or paths to stdout and return non-zero on failure
# (missing inputs, unreachable node, missing file). Callers MUST treat empty
# stdout as "absent" rather than "error".
#
# Override hooks for tests / non-standard layouts:
#   OSTE_NODE_PENDING_REVIEW_DIR — node-side pending-review dir (default /tmp/oste-pending-review)
#   OSTE_NODE_TASKS_FILE         — node-side tasks.json path (default \$HOME/.config/ghostty-launcher/tasks.json)

_node_pr_q() {
	printf '%q' "$1"
}

# Fetch the pending-review JSON for <task_id> from <node_id>.
# Prints JSON to stdout, returns non-zero when fetch fails or file is empty.
node_pending_review_fetch() {
	local node_id="$1"
	local task_id="$2"
	local node_dir="${3:-${OSTE_NODE_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}}"
	[[ -n "$node_id" && -n "$task_id" ]] || return 1

	local task_q dir_q remote_path fallback_path
	task_q=$(_node_pr_q "${task_id}.json")
	dir_q=$(_node_pr_q "$node_dir")
	remote_path="${dir_q}/${task_q}"
	fallback_path=""
	if [[ "$node_dir" == "/tmp/oste-pending-review" ]]; then
		fallback_path="$(_node_pr_q "/private/tmp/oste-pending-review")/${task_q}"
	fi

	local out remote_cmd
	if [[ -n "$fallback_path" ]]; then
		remote_cmd="if [ -f ${remote_path} ]; then cat -- ${remote_path}; elif [ -f ${fallback_path} ]; then cat -- ${fallback_path}; fi"
	else
		remote_cmd="if [ -f ${remote_path} ]; then cat -- ${remote_path}; fi"
	fi
	out=$(node_exec "$node_id" "$remote_cmd" 2>/dev/null) || return 1
	[[ -n "$out" ]] || return 1
	printf '%s' "$out"
}

# Fetch the tasks.json row for <task_id> from <node_id>.
# Prints JSON to stdout, returns non-zero when fetch fails or row is empty.
node_pending_review_task_row() {
	local node_id="$1"
	local task_id="$2"
	local node_tasks_file="${3:-${OSTE_NODE_TASKS_FILE:-\$HOME/.config/ghostty-launcher/tasks.json}}"
	[[ -n "$node_id" && -n "$task_id" ]] || return 1

	local task_q
	task_q=$(_node_pr_q "$task_id")

	local out
	out=$(node_exec "$node_id" "if [ -f ${node_tasks_file} ]; then jq -c --arg id ${task_q} '.tasks[\$id] // empty' ${node_tasks_file}; fi" 2>/dev/null) || return 1
	[[ -n "$out" ]] || return 1
	printf '%s' "$out"
}

# Test whether a handoff artifact exists on <node_id>.
# Resolves relative paths against the optional <project_dir> argument.
# Returns 0 when present, non-zero otherwise.
node_pending_review_handoff_exists() {
	local node_id="$1"
	local handoff="$2"
	local project_dir="${3:-}"
	[[ -n "$node_id" && -n "$handoff" ]] || return 1

	local resolved="$handoff"
	if [[ "$handoff" != /* && -n "$project_dir" ]]; then
		resolved="${project_dir}/${handoff}"
	fi
	local quoted result
	quoted=$(_node_pr_q "$resolved")
	result=$(node_exec "$node_id" "if [ -f ${quoted} ]; then echo yes; else echo no; fi" 2>/dev/null) || return 1
	[[ "$result" == "yes" ]]
}

# Combined truth resolver — prints a single JSON object describing node-side
# truth so an orchestrator/watchdog can make a routing decision in one shot:
#   {pending_review: <object|null>, task_row: <object|null>, handoff_present: <bool>}
# Returns 0 even when individual pieces are absent; callers branch on the
# returned JSON. Returns non-zero only on argument errors.
node_pending_review_resolve() {
	local node_id="$1"
	local task_id="$2"
	[[ -n "$node_id" && -n "$task_id" ]] || return 1

	local pending_review_json="null"
	local task_row_json="null"
	local handoff_present="false"
	local fetched

	if fetched=$(node_pending_review_fetch "$node_id" "$task_id" 2>/dev/null); then
		[[ -n "$fetched" ]] && pending_review_json="$fetched"
	fi
	if fetched=$(node_pending_review_task_row "$node_id" "$task_id" 2>/dev/null); then
		[[ -n "$fetched" ]] && task_row_json="$fetched"
	fi

	if [[ "$task_row_json" != "null" ]]; then
		local handoff handoff_project_dir
		handoff=$(printf '%s' "$task_row_json" | jq -r '.handoff_file // empty' 2>/dev/null || true)
		handoff_project_dir=$(printf '%s' "$task_row_json" | jq -r '.project_dir // empty' 2>/dev/null || true)
		if [[ -n "$handoff" ]]; then
			if node_pending_review_handoff_exists "$node_id" "$handoff" "$handoff_project_dir"; then
				handoff_present="true"
			fi
		fi
	fi

	jq -cn \
		--argjson pr "$pending_review_json" \
		--argjson tr "$task_row_json" \
		--arg handoff_present "$handoff_present" \
		'{pending_review: $pr, task_row: $tr, handoff_present: ($handoff_present == "true")}'
}
