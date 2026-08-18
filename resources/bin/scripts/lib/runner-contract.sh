#!/bin/bash
#
# runner-contract.sh — the Symphony Runner protocol's shared, machine-readable
# outcome vocabulary, in TWO EXPLICIT LAYERS.
#
# This library exists because the node façade (scripts/oste-runner.sh) and the
# hub-side wrapper (scripts/oste-remote-runner.sh) each used to carry their own
# hand-copied vocabulary, and the two had already diverged semantically. The
# operator ruling on the deferred "shared vocabulary" item is that the fix is
# NOT one flat merged list: hub-only transport/evidence outcomes must never be
# added to the node façade merely to make two lists identical. So:
#
#   LAYER 1 — the NODE FAÇADE ENVELOPE VOCABULARY.
#     Exactly the outcomes a node façade response may carry, per verb. This is
#     the contract on the wire between the two programs. The façade's own
#     generator is pinned to it, and the wrapper's node-response validator
#     accepts NOTHING outside it.
#
#   LAYER 2 — the WRAPPER-ONLY SUPERSET.
#     Transport, response-loss, evidence-transfer and reconciliation outcomes
#     that only the hub can produce, because only the hub observes the channel.
#     They are enumerated SEPARATELY, in named classes, and every consumer can
#     ask `runner_outcome_layer` which layer an outcome belongs to. A node
#     response claiming one of these is a node claiming an authority it does
#     not have, and the wrapper refuses it.
#
# The two layers are DISJOINT by construction (asserted by the contract tests
# in test/test-runner-facade.sh §V and test/test-remote-runner.sh §V), which is
# what makes "wrapper-only outcomes cannot be mistaken for node-emitted
# outcomes" a mechanical property rather than a naming convention.
#
# ── Exit codes are LAYER-SPECIFIC, deliberately ─────────────────────────
# `runner_node_outcome_exit_code` is total over Layer 1 only and is the node
# façade's map. `runner_wrapper_outcome_exit_code` extends it over Layer 2 and
# is the hub's map. The wrapper map is defined as "node map first, then the
# wrapper-only arms", so the two can never disagree about a SHARED outcome
# while still letting the hub give its own outcomes their own classes — most
# pointedly `evidence_binding_conflict` = 3, an owner-reconciled PARK, where
# every other transport refusal is a decided 2.
#
# NO function here has a default arm that answers 0. An unmapped outcome
# returns non-zero and prints nothing that a caller could read as success.
#
# Sourced by scripts/oste-runner.sh and scripts/oste-remote-runner.sh. Both
# source it UNCONDITIONALLY and fail closed when it is absent: a vocabulary
# that silently falls back to a private copy is the defect this file replaces.

[[ -n "${__OSTE_RUNNER_CONTRACT_SH:-}" ]] && return 0
__OSTE_RUNNER_CONTRACT_SH=1

runner_schema_version() { printf '1'; }

# ═══════════════════════════════════════════════════════════════════
# Verbs
# ═══════════════════════════════════════════════════════════════════

# The six caller-facing façade verbs, in the order --help prints them.
runner_verb_vocabulary() {
	printf '%s\n' launch inspect cancel result capabilities dispose
}

# Protocol SCOPES: the six verbs plus `remote`, the hub layer's own scope.
# `remote` is a scope, never a verb — no caller may invoke it.
runner_verb_is_known() {
	case "${1:-}" in
		launch | inspect | cancel | result | capabilities | dispose | remote) return 0 ;;
		*) return 1 ;;
	esac
}

# ═══════════════════════════════════════════════════════════════════
# LAYER 1 — node façade envelope vocabulary
# ═══════════════════════════════════════════════════════════════════
#
# One scope per façade verb. These are the ONLY outcomes a node response may
# carry. Adding a member here is a protocol change that both programs see.

runner_node_outcome_vocabulary() {
	case "${1:-}" in
		launch)
			printf '%s\n' accepted reused binding_anomaly ambiguous_reuse precondition_refused \
				allocation_refused registration_failed uncertain unknown \
				invalid_request lock_unavailable internal_error
			;;
		inspect)
			printf '%s\n' running owner_review_required review_in_progress failed unknown \
				generation_mismatch invalid_request lock_unavailable internal_error
			;;
		cancel)
			printf '%s\n' cancel_requested already_terminal generation_mismatch unknown owner_changed \
				invalid_request lock_unavailable internal_error
			;;
		result)
			printf '%s\n' published not_publishable envelope_conflict generation_mismatch unknown \
				invalid_request journal_unavailable lock_unavailable internal_error
			;;
		capabilities)
			printf '%s\n' ok invalid_request internal_error
			;;
		dispose)
			printf '%s\n' released already_released not_disposable generation_mismatch unknown \
				invalid_request lock_unavailable internal_error
			;;
		*) return 1 ;;
	esac
	return 0
}

# Every Layer 1 member across every verb, de-duplicated.
#
# Membership below is a string test over a captured list rather than a `read`
# loop over a process substitution: an early `return` out of such a loop leaves
# the generator writing into a closed pipe, and this library must never put a
# stray `write error` on the stderr of a program whose whole contract is one
# JSON object on stdout and diagnostics on stderr.
runner_node_outcome_union() {
	local verb
	for verb in $(runner_verb_vocabulary); do
		runner_node_outcome_vocabulary "$verb"
	done | LC_ALL=C sort -u
}

runner_node_outcome_is_known() {
	local verb="${1:-}" outcome="${2:-}" set
	[[ -n "$outcome" ]] || return 1
	set=$(runner_node_outcome_vocabulary "$verb") || return 1
	[[ " ${set//$'\n'/ } " == *" ${outcome} "* ]]
}

# Membership in ANY node verb scope, ignoring which verb. Used to prove the
# two layers are disjoint, never to validate a response: a response is always
# validated against the scope of the verb that was actually sent.
runner_outcome_is_node_emittable() {
	local outcome="${1:-}" set
	[[ -n "$outcome" ]] || return 1
	set=$(runner_node_outcome_union)
	[[ " ${set//$'\n'/ } " == *" ${outcome} "* ]]
}

# The node façade's exit map. TOTAL over Layer 1 and over Layer 1 ONLY: a
# wrapper-only outcome must NOT resolve here, because a node layer that can
# price a transport refusal is a node layer that has quietly adopted one.
#
# The default arm prints nothing and returns non-zero, so a fall-through is
# distinguishable from a mapped 0 without inspecting the printed code.
runner_node_outcome_exit_code() {
	case "${1:-}" in
		accepted | reused | running | owner_review_required | review_in_progress | failed | \
			cancel_requested | already_terminal | published | released | already_released | ok)
			printf '0'
			;;
		invalid_request) printf '1' ;;
		generation_mismatch | precondition_refused | allocation_refused | ambiguous_reuse | \
			owner_changed | not_publishable | envelope_conflict | not_disposable)
			printf '2'
			;;
		unknown | uncertain | binding_anomaly | journal_unavailable) printf '3' ;;
		lock_unavailable) printf '4' ;;
		internal_error | registration_failed) printf '5' ;;
		*) return 1 ;;
	esac
	return 0
}

# ═══════════════════════════════════════════════════════════════════
# LAYER 2 — wrapper-only superset (hub/transport/evidence reconciliation)
# ═══════════════════════════════════════════════════════════════════
#
# Enumerated in four named classes so that "wrapper-only" is a checkable
# property with a stated reason, not a list someone has to remember. Nothing
# here may ever appear in Layer 1.
#
#   transport         the hub's view of the channel itself
#   response_loss     the hub could not read an answer at all
#   evidence_transfer the hub's exact-byte retrieval and binding
#   reconciliation    the hub's ONE deterministic post-loss reconcile
runner_wrapper_only_outcome_classes() {
	printf '%s\n' transport response_loss evidence_transfer reconciliation
}

runner_wrapper_only_outcome_vocabulary() {
	local class="${1:-}"
	case "$class" in
		transport)
			printf '%s\n' transport_unavailable transport_unauthenticated fake_transport_refused \
				fencing_mismatch node_refused
			;;
		response_loss)
			printf '%s\n' response_lost
			;;
		evidence_transfer)
			printf '%s\n' artifact_too_large transfer_unavailable digest_mismatch \
				bundle_unverifiable hub_local_artifact_refused evidence_binding_conflict
			;;
		reconciliation)
			printf '%s\n' reconciled_accepted reconciled_absent
			;;
		"")
			local c
			for c in $(runner_wrapper_only_outcome_classes); do
				runner_wrapper_only_outcome_vocabulary "$c"
			done
			;;
		*) return 1 ;;
	esac
	return 0
}

# Prints the class of a wrapper-only outcome; prints nothing and returns
# non-zero for anything else, including a Layer 1 outcome.
#
# This is a SECOND statement of the class split, and a second statement is how
# the two drift. It is therefore held to the enumeration above by an explicit
# contract test (§V "the class index agrees with the class enumeration, in both
# directions") rather than by care.
runner_wrapper_only_outcome_class() {
	case "${1:-}" in
		transport_unavailable | transport_unauthenticated | fake_transport_refused | \
			fencing_mismatch | node_refused)
			printf 'transport'
			;;
		response_lost) printf 'response_loss' ;;
		artifact_too_large | transfer_unavailable | digest_mismatch | \
			bundle_unverifiable | hub_local_artifact_refused | evidence_binding_conflict)
			printf 'evidence_transfer'
			;;
		reconciled_accepted | reconciled_absent) printf 'reconciliation' ;;
		*) return 1 ;;
	esac
	return 0
}

runner_outcome_is_wrapper_only() {
	runner_wrapper_only_outcome_class "${1:-}" >/dev/null 2>&1
}

# The single question every consumer should ask: which layer produced this?
# Prints `node` or `wrapper_only`; prints nothing and returns non-zero for an
# outcome that is in neither layer. There is no third answer and no default.
runner_outcome_layer() {
	local outcome="${1:-}"
	if runner_outcome_is_node_emittable "$outcome"; then
		printf 'node'
		return 0
	fi
	if runner_outcome_is_wrapper_only "$outcome"; then
		printf 'wrapper_only'
		return 0
	fi
	return 1
}

# ═══════════════════════════════════════════════════════════════════
# The hub layer's view: Layer 1 passed through, plus Layer 2
# ═══════════════════════════════════════════════════════════════════
#
# A verb scope is exactly Layer 1 for that verb — the wrapper passes a node
# answer through unchanged, so its per-verb vocabulary IS the node's. The
# `remote` scope is the wrapper's own union: Layer 2 plus everything Layer 1
# can pass through.
runner_wrapper_outcome_vocabulary() {
	local scope="${1:-}"
	case "$scope" in
		remote)
			runner_wrapper_only_outcome_vocabulary
			runner_node_outcome_union
			;;
		*) runner_node_outcome_vocabulary "$scope" ;;
	esac
}

runner_wrapper_outcome_is_known() {
	local scope="${1:-}" outcome="${2:-}" set
	[[ -n "$outcome" ]] || return 1
	set=$(runner_wrapper_outcome_vocabulary "$scope") || return 1
	[[ -n "$set" ]] || return 1
	[[ " ${set//$'\n'/ } " == *" ${outcome} "* ]]
}

# The hub's exit map: the node map first, then the wrapper-only arms. Deriving
# it from the node map is what guarantees the two layers can never disagree
# about a SHARED outcome — there is no second copy to drift.
#
# `evidence_binding_conflict` is exit 3, not 2: two different transfers claim
# one (task, generation) binding and this host cannot tell which is right. That
# is an owner-reconciled PARK, not a decided refusal, and the binding is never
# overwritten. Keeping it distinct from the 2-class refusals is the reason this
# map is layer-specific rather than shared.
#
# The default arm prints nothing and returns non-zero.
runner_wrapper_outcome_exit_code() {
	local outcome="${1:-}" code
	if code=$(runner_node_outcome_exit_code "$outcome"); then
		printf '%s' "$code"
		return 0
	fi
	case "$outcome" in
		reconciled_accepted) printf '0' ;;
		fencing_mismatch | node_refused | artifact_too_large | transfer_unavailable | \
			digest_mismatch | bundle_unverifiable | transport_unauthenticated | \
			fake_transport_refused | hub_local_artifact_refused)
			printf '2'
			;;
		response_lost | reconciled_absent | transport_unavailable | evidence_binding_conflict)
			printf '3'
			;;
		*) return 1 ;;
	esac
	return 0
}

# ═══════════════════════════════════════════════════════════════════
# Shared diagnostics helper
# ═══════════════════════════════════════════════════════════════════
#
# Argument parsing rejects an unrecognised flag BEFORE any validator runs, so
# whatever it echoes has passed through no secret refusal at all. A mistyped
# credential flag would otherwise land verbatim on stderr AND in the JSON
# `reason` a scheduler persists as a durable receipt. Only the flag NAME is
# diagnostic: drop the inline `=value`, reduce to the flag charset, truncate.
runner_flag_label() {
	local raw="${1%%=*}"
	raw="${raw//[^A-Za-z0-9._-]/?}"
	printf '%s' "${raw:0:64}"
}
