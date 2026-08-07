#!/bin/bash
# autoreview-contract.sh — the single authoritative declaration of the
# canonical autoreview helper policy and evidence schema shared by the
# adapter (scripts/lib/autoreview-adapter.sh) and the lifecycle
# (scripts/lib/review-lifecycle.sh). Dependency direction is strictly
# consumer -> contract: the adapter and the lifecycle both source this file;
# this file sources nothing, and the lifecycle never sources the adapter.
#
# Every canonical pin literal lives HERE and only here. Consumers read the
# readonly constants and the machine-readable JSON declarations (via
# `jq --argjson`) instead of restating literals; the drift tests fail any
# second copy. Array declarations are jq-sorted and comparisons use jq
# `keys` (which sorts), so declared order and compared order agree.
#
# This is an application-integrity contract, not a cryptographic or OS
# privilege boundary: value pinning prevents wrong-helper and configuration
# drift plus accidental caller error, never a fully malicious same-user
# process.

# Source guard: a namespaced function AND readonly-definition check — never
# an environment flag. An inherited environment variable shows up as
# `declare -x` (not `declare -r`), and an exported shell function cannot
# fake the readonly attribute, so ambient environment can neither suppress
# initialization nor pre-satisfy the guard.
if declare -f autoreview_contract_loaded >/dev/null 2>&1 &&
	[[ "$(declare -p AUTOREVIEW_CONTRACT_SHA256 2>/dev/null)" == "declare -r"* ]]; then
	return 0
fi

# Version axes are distinct and must never be conflated: `version` in an
# evidence object is the evidence-schema version; `helper.policy_version` is
# the helper-authorization-policy version; `receipt_version` is the canonical
# receipt envelope/payload version.
readonly AUTOREVIEW_CONTRACT_HELPER_POLICY_VERSION=1
readonly AUTOREVIEW_CONTRACT_EVIDENCE_SCHEMA_VERSION=1
readonly AUTOREVIEW_CONTRACT_RECEIPT_VERSION=2

# Canonical helper identity (agent-skills receipt v2). Two origin
# representations under distinct names (never one ambiguous variable): the
# fetch-form URL is the identity-verification INPUT (both sides are
# normalized before comparison), while the normalized identity is what
# emitted evidence carries and what the lifecycle value-pins against.
readonly AUTOREVIEW_CONTRACT_ORIGIN_FETCH_URL="https://github.com/ostehost/agent-skills.git"
readonly AUTOREVIEW_CONTRACT_ORIGIN_IDENTITY="github.com/ostehost/agent-skills"
readonly AUTOREVIEW_CONTRACT_REVISION="592af00c481954b5e7972cbeb9fac1983ab7fdd5"
readonly AUTOREVIEW_CONTRACT_RELPATH="skills/autoreview/scripts/autoreview"
readonly AUTOREVIEW_CONTRACT_SHA256="f2622807509c31989f22f8bd7f86964d1b758ae1b5953fc9a7e88b8969b61ed5"
# Expected committed tree mode, verified at identity admission. This is an
# implicit policy value, not an evidence key.
readonly AUTOREVIEW_CONTRACT_TREE_MODE="100755"

# The nine lifecycle binding coordinates a receipt binds to (jq-sorted).
readonly AUTOREVIEW_CONTRACT_BINDING_KEYS_JSON='["end_commit","owner_review_request_id","review_attempt_id","review_revision","session_key","task_generation","task_id","work_item_ref","workroom_ref"]'

# The exact twenty caller-emitted top-level keys of an input/emitted evidence
# object (jq-sorted). The persisted lifecycle record is this object plus the
# three lifecycle-stamped fields (recorded_at, auto_approved,
# final_decision_authority) — nothing here claims the lifecycle persists a
# 20-key object.
readonly AUTOREVIEW_CONTRACT_EVIDENCE_KEYS_JSON='["blocker_count","changed_paths_digest","end_commit","helper","owner_review_request_id","payload_sha256","posture","receipt_version","review_attempt_id","review_revision","scope_digest","session_key","status","stdout_artifact_digest","target_commit","task_generation","task_id","version","work_item_ref","workroom_ref"]'

# The exact six helper-identity keys (jq-sorted).
readonly AUTOREVIEW_CONTRACT_HELPER_KEYS_JSON='["origin","policy_version","realpath","relpath","revision","sha256"]'

# Conservative status→posture map. A clean receipt is closeout-ELIGIBLE
# evidence only; it never approves, closes, or transitions workroom state.
readonly AUTOREVIEW_CONTRACT_POSTURE_MAP_JSON='{"clean":"closeout_eligible","error":"blocked","findings":"changes_requested"}'

# Normalize a git remote URL to lowercase host/owner/repo so https and ssh
# spellings of the same repository compare equal. Owned by the contract
# because origin-identity semantics ARE policy; the adapter delegates here.
autoreview_contract_normalize_origin() {
	local url="${1:-}"
	[[ -n "$url" ]] || return 1
	url="${url%/}"
	url="${url%.git}"
	case "$url" in
		git@*:*)
			url="${url#git@}"
			url="${url%%:*}/${url#*:}"
			;;
		ssh://git@*) url="${url#ssh://git@}" ;;
		https://*) url="${url#https://}" ;;
		http://*) url="${url#http://}" ;;
		git://*) url="${url#git://}" ;;
		*) return 1 ;;
	esac
	printf '%s' "$url" | tr '[:upper:]' '[:lower:]'
}

# Host-side resolution convention (PAR-599) for the dedicated PINNED test/CI
# checkout cache: revision-keyed, so pin rotation never collides and suites
# never depend on the HEAD of a live development clone. Production checkout
# resolution (plan step 12) is a separate, host-owned concern.
autoreview_contract_canonical_cache_dir() {
	printf '%s/agent-skills-%s\n' \
		"${OSTE_AUTOREVIEW_CANONICAL_CACHE_ROOT:-$HOME/.cache/ghl-autoreview}" \
		"$AUTOREVIEW_CONTRACT_REVISION"
}

# Post-source validation: every constant and JSON declaration must parse and
# satisfy its own invariants, and the two origin representations must agree
# under normalization. Runs on every load; a contract that cannot prove
# itself coherent fails the whole source (fail closed) and never defines the
# load marker.
_autoreview_contract_validate() {
	[[ "$AUTOREVIEW_CONTRACT_HELPER_POLICY_VERSION" == "1" ]] || return 1
	[[ "$AUTOREVIEW_CONTRACT_EVIDENCE_SCHEMA_VERSION" == "1" ]] || return 1
	[[ "$AUTOREVIEW_CONTRACT_RECEIPT_VERSION" == "2" ]] || return 1
	[[ "$AUTOREVIEW_CONTRACT_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
	[[ "$AUTOREVIEW_CONTRACT_SHA256" =~ ^[0-9a-f]{64}$ ]] || return 1
	[[ "$AUTOREVIEW_CONTRACT_TREE_MODE" == "100755" ]] || return 1
	[[ -n "$AUTOREVIEW_CONTRACT_RELPATH" && "$AUTOREVIEW_CONTRACT_RELPATH" != /* ]] || return 1
	[[ -n "$AUTOREVIEW_CONTRACT_ORIGIN_FETCH_URL" && -n "$AUTOREVIEW_CONTRACT_ORIGIN_IDENTITY" ]] || return 1
	[[ "$(autoreview_contract_normalize_origin "$AUTOREVIEW_CONTRACT_ORIGIN_FETCH_URL")" == "$AUTOREVIEW_CONTRACT_ORIGIN_IDENTITY" ]] || return 1
	jq -e 'type == "array" and length == 9 and . == sort and all(.[]; type == "string" and length > 0)' \
		>/dev/null 2>&1 <<<"$AUTOREVIEW_CONTRACT_BINDING_KEYS_JSON" || return 1
	jq -e 'type == "array" and length == 20 and . == sort and all(.[]; type == "string" and length > 0)' \
		>/dev/null 2>&1 <<<"$AUTOREVIEW_CONTRACT_EVIDENCE_KEYS_JSON" || return 1
	jq -e 'type == "array" and length == 6 and . == sort and all(.[]; type == "string" and length > 0)' \
		>/dev/null 2>&1 <<<"$AUTOREVIEW_CONTRACT_HELPER_KEYS_JSON" || return 1
	jq -e 'type == "object" and keys == ["clean", "error", "findings"] and
		.clean == "closeout_eligible" and .findings == "changes_requested" and
		.error == "blocked"' \
		>/dev/null 2>&1 <<<"$AUTOREVIEW_CONTRACT_POSTURE_MAP_JSON" || return 1
	jq -e --argjson binding "$AUTOREVIEW_CONTRACT_BINDING_KEYS_JSON" \
		'. as $evidence | ($binding - ["review_revision"] | all(.[]; . as $k | $evidence | index($k) != null))' \
		>/dev/null 2>&1 <<<"$AUTOREVIEW_CONTRACT_EVIDENCE_KEYS_JSON" || return 1
	return 0
}

if ! _autoreview_contract_validate; then
	printf 'autoreview-contract: contract_invalid: refusing to load (fail closed)\n' >&2
	return 1
fi

# Defined only after validation succeeds: consumers must check for this
# function after sourcing; its absence means the contract failed closed.
autoreview_contract_loaded() {
	return 0
}
