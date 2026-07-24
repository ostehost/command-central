#!/bin/bash
#
# oste-notification-hook.sh — Claude Code Notification hook for visible lanes
#
# Wakes the owning workroom with sanitized idle/attention context. This hook is
# fail-soft and never blocks or finalizes a lane; Stop/TaskCompleted/SessionEnd
# remain responsible for lifecycle state.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
readonly SCRIPT_DIR
readonly TASKS_FILE="${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"
readonly NOTIFICATION_DIR="${OSTE_NOTIFICATION_DIR:-/tmp/oste-lane-notifications}"
# shellcheck source=lib/task-id.sh
source "${SCRIPT_DIR}/lib/task-id.sh"
# shellcheck source=lib/task-owner-identity.sh
source "${SCRIPT_DIR}/lib/task-owner-identity.sh"

notification_owner_lock_held=false
release_notification_owner_lock() {
	if [[ "$notification_owner_lock_held" == "true" ]]; then
		task_owner_transition_lock_release >/dev/null 2>&1 || true
		notification_owner_lock_held=false
	fi
}
trap 'release_notification_owner_lock' EXIT
trap 'exit 0' ERR

input=$(cat)
notification_type=$(printf '%s' "$input" | jq -r '.notification_type // ""' 2>/dev/null || true)
case "$notification_type" in
	idle_prompt | agent_needs_input | agent_completed) ;;
	*) exit 0 ;;
esac

session_id=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null || true)
transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || true)
message=$(printf '%s' "$input" | jq -r '.message // ""' 2>/dev/null || true)

task_id="${OSTE_TASK_ID:-}"
resolution_source="env"
if [[ -z "$task_id" && -n "$cwd" ]]; then
	cwd_hash=$(printf '%s' "$cwd" | shasum -a 256 2>/dev/null | cut -d' ' -f1 || true)
	map_file="/tmp/oste-stop-map-${cwd_hash}"
	if [[ -f "$map_file" ]]; then
		map_content=$(head -1 "$map_file" 2>/dev/null || true)
		task_id="${map_content%%:*}"
		resolution_source="cwd-map"
	fi
fi
[[ -n "$task_id" ]] || exit 0
task_id_validate "$task_id" >/dev/null 2>&1 || exit 0

# Replacement publishes owner routing under this same lease. Read one immutable
# row and derive every routing field from it; never validate one generation and
# then re-read a mixture of old/new fields from tasks.json. Receipt publication
# stays inside the lease, while the network wake below intentionally does not.
[[ -f "$TASKS_FILE" ]] || exit 0
task_owner_transition_lock_acquire "$task_id" || exit 0
notification_owner_lock_held=true
task_row=$(jq -ce --arg id "$task_id" '.tasks[$id] // empty' "$TASKS_FILE" 2>/dev/null) || exit 0
task_generation=$(printf '%s' "$task_row" | jq -r '.task_generation // ""' 2>/dev/null || true)
[[ "$task_generation" == "${OSTE_TASK_GENERATION:-}" ]] || exit 0

# Only owner-bound/workroom lanes need this wake. Standalone launcher tasks keep
# their existing local notification behavior and do not spam main/workrooms.
workroom_ref=""
work_item_ref=""
session_key=""
callback_url=""
project_id=""
project_path="${cwd:-}"
task_status="unknown"
handoff_file=""
workroom_ref=$(printf '%s' "$task_row" | jq -r '.workroom_ref // ""' 2>/dev/null || true)
work_item_ref=$(printf '%s' "$task_row" | jq -r '.work_item_ref // ""' 2>/dev/null || true)
session_key=$(printf '%s' "$task_row" | jq -r '.session_key // ""' 2>/dev/null || true)
callback_url=$(printf '%s' "$task_row" | jq -r '.callback_url // ""' 2>/dev/null || true)
project_id=$(printf '%s' "$task_row" | jq -r '.project_name // .project // ""' 2>/dev/null || true)
project_path=$(printf '%s' "$task_row" | jq -r '.project_dir // empty' 2>/dev/null || true)
task_status=$(printf '%s' "$task_row" | jq -r '.status // "unknown"' 2>/dev/null || echo "unknown")
handoff_file=$(printf '%s' "$task_row" | jq -r '.handoff_file // .expected_artifact // ""' 2>/dev/null || true)
# Require both a concrete owner session and workroom/work-item scope. A bare
# session key is a return address, not proof this task belongs to a workroom.
[[ -n "$session_key" ]] || exit 0
[[ -n "$workroom_ref" || -n "$work_item_ref" ]] || exit 0

pending_review_path="${OSTE_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}/${task_id}.json"
pending_review_state="missing"
reviewed="false"
review_blocker_count=""
if [[ -f "$pending_review_path" ]]; then
	pending_review_row=$(jq -ce '.' "$pending_review_path" 2>/dev/null || true)
	pending_review_generation=$(printf '%s' "$pending_review_row" | jq -r '.task_generation // ""' 2>/dev/null || true)
	if [[ "$pending_review_generation" == "$task_generation" ]]; then
		pending_review_state=$(printf '%s' "$pending_review_row" | jq -r '.review_state // "pending"' 2>/dev/null || echo "pending")
		reviewed=$(printf '%s' "$pending_review_row" | jq -r '.reviewed // false' 2>/dev/null || echo "false")
		review_blocker_count=$(printf '%s' "$pending_review_row" | jq -r '.review_blocker_count // empty' 2>/dev/null || true)
	fi
fi

oste_report_path="${project_path:-$cwd}/.oste-report.yaml"
oste_report_present="false"
[[ -f "$oste_report_path" ]] && oste_report_present="true"
handoff_present="false"
handoff_path=""
if [[ -n "$handoff_file" && -n "$project_path" ]]; then
	if [[ "$handoff_file" = /* ]]; then
		handoff_path="$handoff_file"
	else
		handoff_path="${project_path%/}/${handoff_file}"
	fi
	[[ -f "$handoff_path" ]] && handoff_present="true"
fi

last_message_file="/tmp/oste-last-message-${task_id}"
last_message_hash=""
last_message_bytes="0"
last_message_truncated="false"
if [[ -f "$last_message_file" ]]; then
	last_message_hash=$(shasum -a 256 "$last_message_file" 2>/dev/null | cut -d' ' -f1 || true)
	last_message_bytes=$(wc -c <"$last_message_file" 2>/dev/null || echo 0)
	[[ "$last_message_bytes" -gt 500 ]] && last_message_truncated="true"
fi

fingerprint=$(printf '%s|%s|%s|%s|%s|%s|%s' "$task_id" "$task_generation" "$notification_type" "$session_id" "$last_message_hash" "$oste_report_present" "$handoff_present" | shasum -a 256 | cut -d' ' -f1)
idempotency_key="claude-notification:${task_id}:${notification_type}:${fingerprint:0:16}"

summary="Claude Code ${notification_type}: task=${task_id} status=${task_status} report=${oste_report_present} handoff=${handoff_present} review_state=${pending_review_state}"

mkdir -p "$NOTIFICATION_DIR" 2>/dev/null || true
receipt=$(jq -cn \
	--arg schema "visible_lane.notification/v1" \
	--arg source "claude_code_notification" \
	--arg hook_event "Notification" \
	--arg notification_type "$notification_type" \
	--arg task_id "$task_id" \
	--arg task_generation "$task_generation" \
	--arg project "$project_id" \
	--arg project_path "$project_path" \
	--arg task_status "$task_status" \
	--arg session_key "$session_key" \
	--arg callback_url "$callback_url" \
	--arg workroom_ref "$workroom_ref" \
	--arg work_item_ref "$work_item_ref" \
	--arg claude_session_id "$session_id" \
	--arg transcript_path "$transcript_path" \
	--arg resolution_source "$resolution_source" \
	--arg oste_report_present "$oste_report_present" \
	--arg handoff_file "$handoff_file" \
	--arg handoff_path "$handoff_path" \
	--arg handoff_present "$handoff_present" \
	--arg pending_review_path "$pending_review_path" \
	--arg pending_review_state "$pending_review_state" \
	--arg reviewed "$reviewed" \
	--arg review_blocker_count "$review_blocker_count" \
	--arg last_message_path "$last_message_file" \
	--arg last_message_sha256 "$last_message_hash" \
	--arg last_message_bytes "$last_message_bytes" \
	--arg last_message_truncated "$last_message_truncated" \
	--arg hook_message_sha256 "$(printf '%s' "$message" | shasum -a 256 2>/dev/null | cut -d' ' -f1 || true)" \
	--arg hook_message_bytes "$(printf '%s' "$message" | wc -c 2>/dev/null | tr -d ' ' || echo 0)" \
	--arg idempotency_key "$idempotency_key" \
	'{
		schema: $schema,
		source: $source,
		hook_event: $hook_event,
		notification_type: $notification_type,
		task_id: $task_id,
		task_generation: (if $task_generation == "" then null else $task_generation end),
		project: (if $project == "" then null else $project end),
		project_path: (if $project_path == "" then null else $project_path end),
		task_status: $task_status,
		session_key: (if $session_key == "" then null else $session_key end),
		callback_url: (if $callback_url == "" then null else $callback_url end),
		workroom_ref: (if $workroom_ref == "" then null else $workroom_ref end),
		work_item_ref: (if $work_item_ref == "" then null else $work_item_ref end),
		claude_session_id: (if $claude_session_id == "" then null else $claude_session_id end),
		transcript_path: (if $transcript_path == "" then null else $transcript_path end),
		resolution_source: $resolution_source,
		artifact: {
			oste_report_present: ($oste_report_present == "true"),
			handoff_file: (if $handoff_file == "" then null else $handoff_file end),
			handoff_path: (if $handoff_path == "" then null else $handoff_path end),
			handoff_present: ($handoff_present == "true"),
			pending_review_path: $pending_review_path,
			pending_review_state: $pending_review_state,
			reviewed: ($reviewed == "true"),
			review_blocker_count: (if $review_blocker_count == "" then null else ($review_blocker_count | tonumber? // null) end)
		},
		last_assistant: {
			path: $last_message_path,
			sha256: (if $last_message_sha256 == "" then null else $last_message_sha256 end),
			bytes: ($last_message_bytes | tonumber? // 0),
			truncated: ($last_message_truncated == "true")
		},
		idempotency_key: $idempotency_key,
		hook_message: {
			sha256: (if $hook_message_sha256 == "" then null else $hook_message_sha256 end),
			bytes: ($hook_message_bytes | tonumber? // 0)
		}
	}')
printf '%s\n' "$receipt" >>"${NOTIFICATION_DIR}/${task_id}.jsonl" 2>/dev/null || true

if [[ -n "${OSTE_TEST_NOTIFICATION_SNAPSHOT_PAUSE:-}" ]]; then
	: >"${OSTE_TEST_NOTIFICATION_SNAPSHOT_PAUSE}.ready"
	while [[ ! -e "${OSTE_TEST_NOTIFICATION_SNAPSHOT_PAUSE}.release" ]]; do sleep 0.02; done
fi

# Network waits must not hold the global owner-transition lease. Every argument
# below is already bound to the exact validated task generation above.
release_notification_owner_lock
notify_script="${OSTE_NOTIFY_SCRIPT:-${SCRIPT_DIR}/oste-notify.sh}"
"$notify_script" \
	--kind attention_required \
	--source claude-notification \
	--owner-only \
	--notification-type "$notification_type" \
	--idempotency-key "$idempotency_key" \
	--task-id "$task_id" \
	--project-id "$project_id" \
	--project-path "$project_path" \
	--session-id "$session_id" \
	--launcher-session-key "$session_key" \
	--launcher-callback-url "$callback_url" \
	--pending-review-path "$pending_review_path" \
	--message "$summary" >/dev/null 2>&1 || true

exit 0
