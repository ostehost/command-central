#!/bin/bash
#
# review-import.sh — Adopt an out-of-band structured review into the launcher
# review lifecycle (PAR-595).
#
# A review that was produced outside the launcher's own dispatch path is
# evidence, not authority. Before this seam existed the only ways to act on one
# were to hand-edit the pending-review receipt or to fabricate a claim for a
# reviewer session that never ran — both mint attempts and intents the lifecycle
# never authorized, and both are invisible to any later audit.
#
# Adoption is therefore a single CAS'd `external_review_adopt` transition
# authored here and adjudicated inside review_lifecycle_transition. This library
# only *validates* and *assembles*; it never writes a receipt, an attempt, or an
# intent itself.
#
# Everything an adoption asserts is checked against the durable receipt before
# the transition is attempted, and again under the review lock by the lifecycle:
#
#   - artifact       — exists, parses, carries the declared sha256 and the
#                      declared number of findings
#   - source lane    — exact task id, task generation, and end commit
#   - scope envelope — work item, workroom, session, callback
#   - lifecycle      — expected receipt state and revision
#   - lineage        — the exact prior review attempt (number AND attempt id)
#                      the external review was produced against, plus the
#                      outstanding owner-review request it consumes
#
# Any mismatch fails closed with no side effects. An exact replay — the same
# request document against an already-adopted receipt — is idempotent: it mints
# no attempt, writes no second intent, and returns the same committed receipt.
#
# Return codes:
#   0  adopted (or exact replay of an existing adoption)
#   1  malformed request, or an artifact that does not match its declaration
#   2  precondition mismatch against the durable receipt (fail closed)
#   3  lost CAS / task-row generation drift
#   4  illegal transition
#   5  receipt committed, external queue projection deferred

[[ -n "${__OSTE_REVIEW_IMPORT_SH:-}" ]] && return 0
__OSTE_REVIEW_IMPORT_SH=1

_review_import_lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if ! declare -f pending_review_build_fixup_intent >/dev/null 2>&1; then
	# shellcheck source=pending-review.sh
	source "${_review_import_lib_dir}/pending-review.sh"
fi
unset _review_import_lib_dir

review_import_artifact_digest() {
	local path="${1:-}" digest
	[[ -s "$path" ]] || return 1
	digest=$(shasum -a 256 "$path" 2>/dev/null | awk '{print $1}')
	[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$digest"
}

# The deterministic identity of an adoption request: every coordinate the
# operator asserted, and nothing that varies between two identical invocations
# (no timestamps, no minted attempt id). Two runs of the same command produce
# the same key, which is what makes an exact replay recognizable — and what
# makes a request that differs in ANY asserted coordinate a different adoption
# rather than a silent no-op.
review_import_adoption_key() {
	local request="${1:-}" canonical digest
	canonical=$(jq -S -c '{
		version: 1,
		task_id: .task_id,
		task_generation: .task_generation,
		end_commit: .end_commit,
		expected_review_revision: .expected_review_revision,
		expected_review_state: .expected_review_state,
		expected_review_attempt: .expected_review_attempt,
		expected_review_attempt_id: (.expected_review_attempt_id // ""),
		expected_owner_review_request_id: .expected_owner_review_request_id,
		artifact_sha256: .artifact_sha256,
		expected_finding_count: .expected_finding_count,
		source_artifact_path: .artifact_path,
		scope: {
			work_item_ref: (.scope.work_item_ref // ""),
			workroom_ref: (.scope.workroom_ref // ""),
			session_key: (.scope.session_key // ""),
			callback_url: (.scope.callback_url // "")
		}
	}' <<<"$request" 2>/dev/null) || return 1
	[[ -n "$canonical" ]] || return 1
	digest=$(printf '%s' "$canonical" | shasum -a 256 | awk '{print $1}')
	[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$digest"
}

_review_import_request_is_wellformed() {
	jq -e '
		type == "object" and
		.version == 1 and
		(.task_id | type == "string" and length > 0) and
		(.task_generation | type == "string" and length > 0) and
		(.end_commit | type == "string" and length > 0) and
		(.expected_review_state | type == "string" and length > 0) and
		(.expected_review_revision | type == "number" and floor == . and . >= 0) and
		(.expected_review_attempt | type == "number" and floor == . and . >= 0) and
		((.expected_review_attempt_id // "") | type == "string") and
		(.expected_owner_review_request_id | type == "string" and length > 0) and
		(.artifact_path | type == "string" and length > 0) and
		(.artifact_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
		(.expected_finding_count | type == "number" and floor == . and . > 0) and
		(.scope | type == "object")
	' >/dev/null 2>&1 <<<"${1:-null}"
}

# An artifact is usable only if it is what the operator said it is: the declared
# digest over the exact bytes on disk, and the declared number of structurally
# complete findings. A digest alone would still admit a well-formed file with no
# actionable content; a count alone would admit substituted bytes.
review_import_validate_artifact() {
	local path="${1:-}" expected_sha="${2:-}" expected_count="${3:-}" digest
	digest=$(review_import_artifact_digest "$path") || {
		echo "Error: review artifact missing or unreadable: ${path}" >&2
		return 1
	}
	if [[ "$digest" != "$expected_sha" ]]; then
		echo "Error: review artifact digest mismatch: declared ${expected_sha}, actual ${digest}" >&2
		return 1
	fi
	if ! jq -e --argjson count "$expected_count" '
		type == "object" and
		(.findings | type == "array") and
		(.findings | length) == $count and
		(.findings | all(
			type == "object" and
			(.title | type == "string" and length > 0) and
			(.body | type == "string" and length > 0)
		)) and
		(.overall_correctness | type == "string" and length > 0)
	' "$path" >/dev/null 2>&1; then
		echo "Error: review artifact is not a usable structured review with ${expected_count} finding(s): ${path}" >&2
		return 1
	fi
	printf '%s' "$digest"
}

# Preserve the adopted artifact beside the receipt, read-only and digest-named,
# before anything references it. The queue payload must point at an immutable
# copy the launcher owns: the source path is an out-of-band scratch file that
# can be rewritten or deleted the moment after adoption.
_review_import_preserve_artifact() {
	local task_id="$1" task_generation="$2" source_path="$3" digest="$4"
	local dir destination tmp existing
	dir="$(_review_lifecycle_pending_dir)/adopted"
	destination="${dir}/$(_review_lifecycle_safe_id "$task_id").$(_review_lifecycle_safe_id "$task_generation").${digest:0:16}.json"
	if [[ -f "$destination" ]]; then
		existing=$(review_import_artifact_digest "$destination") || return 1
		[[ "$existing" == "$digest" ]] || return 1
		printf '%s' "$destination"
		return 0
	fi
	mkdir -p "$dir" 2>/dev/null || return 1
	tmp=$(mktemp "${destination}.tmp.XXXXXX") || return 1
	if ! cat "$source_path" >"$tmp" 2>/dev/null || [[ ! -s "$tmp" ]]; then
		rm -f "$tmp"
		return 1
	fi
	chmod 444 "$tmp" 2>/dev/null || true
	mv "$tmp" "$destination" || {
		rm -f "$tmp"
		return 1
	}
	printf '%s' "$destination"
}

# Every coordinate the request asserts must still be true of the durable
# receipt. Scope is compared field by field against the receipt rather than
# against ambient environment, so an adoption can never re-point a fixup at the
# importer's own workroom or session.
_review_import_receipt_matches_request() {
	local receipt="$1" request="$2"
	jq -e --argjson request "$request" '
		def blank: (. // "");
		.task_id == $request.task_id and
		(.task_generation | blank) == $request.task_generation and
		(.end_commit | blank) == $request.end_commit and
		(.work_item_ref | blank) == ($request.scope.work_item_ref | blank) and
		(.workroom_ref | blank) == ($request.scope.workroom_ref | blank) and
		(.session_key | blank) == ($request.scope.session_key | blank) and
		(.callback_url | blank) == ($request.scope.callback_url | blank) and
		((.review_attempt // 0) == $request.expected_review_attempt) and
		((.review_attempt_id | blank) == ($request.expected_review_attempt_id | blank)) and
		((.owner_review_request_id | blank) == $request.expected_owner_review_request_id)
	' >/dev/null 2>&1 <<<"$receipt"
}

review_import_adopt_external_review() {
	local request="${1:-}"
	local task_id task_generation receipt_path receipt receipt_state
	local artifact_path artifact_sha expected_count adoption_key digest
	local adopted_path project_path attempt attempt_id intent adoption patch
	local expected_revision expected_state expected_attempt expected_attempt_id owner_request_id
	local committed rc=0

	_review_import_request_is_wellformed "$request" || {
		echo "Error: malformed adoption request" >&2
		return 1
	}
	task_id=$(jq -r '.task_id' <<<"$request")
	task_generation=$(jq -r '.task_generation' <<<"$request")
	artifact_path=$(jq -r '.artifact_path' <<<"$request")
	artifact_sha=$(jq -r '.artifact_sha256' <<<"$request")
	expected_count=$(jq -r '.expected_finding_count' <<<"$request")
	expected_revision=$(jq -r '.expected_review_revision' <<<"$request")
	expected_state=$(jq -r '.expected_review_state' <<<"$request")
	expected_attempt=$(jq -r '.expected_review_attempt' <<<"$request")
	expected_attempt_id=$(jq -r '.expected_review_attempt_id // ""' <<<"$request")
	owner_request_id=$(jq -r '.expected_owner_review_request_id' <<<"$request")

	# `owner_waiting` is the only state an out-of-band review may be adopted
	# from: it is where an outstanding owner decision exists to consume. Every
	# other state either has a live in-band attempt that owns the verdict or is
	# already terminal.
	if [[ "$expected_state" != "owner_waiting" ]]; then
		echo "Error: adoption is only defined from review_state=owner_waiting (requested ${expected_state})" >&2
		return 2
	fi

	digest=$(review_import_validate_artifact "$artifact_path" "$artifact_sha" "$expected_count") || return 1
	adoption_key=$(review_import_adoption_key "$request") || return 1

	receipt_path=$(review_lifecycle_receipt_path "$task_id") || return 1
	if [[ ! -s "$receipt_path" ]]; then
		echo "Error: no pending-review receipt for ${task_id}" >&2
		return 2
	fi
	receipt=$(jq -c . "$receipt_path" 2>/dev/null || true)
	[[ -n "$receipt" ]] || {
		echo "Error: unreadable pending-review receipt for ${task_id}" >&2
		return 2
	}
	receipt_state=$(jq -r '.review_state // "pending"' <<<"$receipt")

	# Replay is adjudicated BEFORE the live receipt is compared to the request.
	# A committed adoption has already advanced the very lineage the request
	# asserts (attempt, attempt id, revision), so re-checking those against the
	# live receipt would read every exact replay as a lineage mismatch. The
	# adoption key is the stronger check: it is a digest over every asserted
	# coordinate — task, generation, end commit, source revision and lineage,
	# owner request, artifact digest, finding count, and scope — so an equal key
	# proves the request matched this receipt when it was adopted, and any
	# request differing in one coordinate is a different adoption, not a replay.
	if [[ "$receipt_state" == "awaiting_fixup" ]]; then
		if jq -e --arg key "$adoption_key" --arg task_id "$task_id" --arg generation "$task_generation" '
			.task_id == $task_id and
			((.task_generation // "") == $generation) and
			.external_review_adoption.adoption_key == $key
		' >/dev/null 2>&1 <<<"$receipt"; then
			pending_review_materialize_fixup_intent "$task_id" >/dev/null 2>&1 || true
			printf '%s\n' "$receipt"
			return 0
		fi
		echo "Error: ${task_id} is already awaiting_fixup under a different review outcome" >&2
		return 2
	fi

	if ! _review_import_receipt_matches_request "$receipt" "$request"; then
		echo "Error: adoption request does not match the durable receipt (task/generation/commit/scope/lineage)" >&2
		return 2
	fi
	if [[ "$receipt_state" != "$expected_state" ]]; then
		echo "Error: receipt state is ${receipt_state}, expected ${expected_state}" >&2
		return 2
	fi
	if [[ "$(jq -r '.review_revision // 0' <<<"$receipt")" != "$expected_revision" ]]; then
		echo "Error: receipt revision is $(jq -r '.review_revision // 0' <<<"$receipt"), expected ${expected_revision}" >&2
		return 2
	fi

	project_path=$(jq -r '.project_path // empty' <<<"$receipt")
	if [[ -z "$project_path" ]]; then
		echo "Error: receipt carries no project_path; a fixup would have nowhere to run" >&2
		return 2
	fi

	adopted_path=$(_review_import_preserve_artifact "$task_id" "$task_generation" "$artifact_path" "$digest") || {
		echo "Error: could not preserve an immutable copy of the review artifact" >&2
		return 1
	}

	attempt=$((expected_attempt + 1))
	attempt_id=$(_review_lifecycle_new_id)
	[[ -n "$attempt_id" ]] || return 1

	# The intent (and the source envelope inside it) is derived from the receipt
	# by the same builder the in-band request_fixup path uses, so an adopted
	# fixup is byte-shaped exactly like a dispatched one.
	intent=$(pending_review_build_fixup_intent "$task_id" "$project_path" "$adopted_path" \
		"$expected_count" "$attempt_id" "$attempt") || {
		echo "Error: could not build an attempt-bound fixup intent" >&2
		return 2
	}
	if ! review_lifecycle_envelope_routing_complete "$(jq -c '.source_envelope' <<<"$intent")"; then
		echo "Error: source envelope is workroom-bound but incomplete; adopted fixup would be undeliverable" >&2
		return 2
	fi

	adoption=$(jq -cn \
		--arg task_id "$task_id" \
		--arg task_generation "$task_generation" \
		--arg end_commit "$(jq -r '.end_commit' <<<"$request")" \
		--arg prior_attempt_id "$expected_attempt_id" \
		--arg owner_request_id "$owner_request_id" \
		--arg artifact_sha256 "$digest" \
		--arg artifact_path "$adopted_path" \
		--arg source_artifact_path "$artifact_path" \
		--arg adoption_key "$adoption_key" \
		--arg review_attempt_id "$attempt_id" \
		--arg adopted_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		--argjson source_review_revision "$expected_revision" \
		--argjson prior_review_attempt "$expected_attempt" \
		--argjson review_attempt "$attempt" \
		--argjson finding_count "$expected_count" \
		--argjson scope "$(jq -c '.scope' <<<"$request")" '
		{
			version: 1,
			task_id: $task_id,
			task_generation: $task_generation,
			source_end_commit: $end_commit,
			source_review_revision: $source_review_revision,
			prior_review_attempt: $prior_review_attempt,
			prior_review_attempt_id: (if $prior_attempt_id == "" then null else $prior_attempt_id end),
			owner_review_request_id: $owner_request_id,
			artifact_sha256: $artifact_sha256,
			artifact_path: $artifact_path,
			source_artifact_path: $source_artifact_path,
			finding_count: $finding_count,
			adoption_key: $adoption_key,
			review_attempt: $review_attempt,
			review_attempt_id: $review_attempt_id,
			scope: $scope,
			adopted_at: $adopted_at
		}') || return 1

	patch=$(jq -cn \
		--argjson adoption "$adoption" \
		--argjson intent "$intent" \
		--arg attempt_id "$attempt_id" \
		--arg handoff "$adopted_path" \
		--argjson attempt "$attempt" \
		--argjson finding_count "$expected_count" '
		{
			review_attempt: $attempt,
			review_dispatch_attempts: $attempt,
			review_attempt_id: $attempt_id,
			review_handoff_file: $handoff,
			review_blocker_count: $finding_count,
			review_artifact_sha256: $adoption.artifact_sha256,
			review_backend: "external",
			review_mode: "adopted",
			external_review_adoption: $adoption,
			fixup_intent: $intent
		}') || return 1

	committed=$(review_lifecycle_transition "$task_id" external_review_adopt \
		"$expected_revision" "$expected_attempt_id" "$patch" "$owner_request_id") || rc=$?
	[[ "$rc" -eq 0 ]] || return "$rc"

	if ! pending_review_materialize_fixup_intent "$task_id" >/dev/null 2>&1; then
		echo "Warning: adoption committed but the fixup queue projection was deferred" >&2
		printf '%s\n' "$committed"
		return 5
	fi
	printf '%s\n' "$committed"
}
