#!/bin/bash
# owner-disposition.sh — hermetic owner-decision record and consumed-decision
# store for `oste-runner dispose`.
#
# ── What this is, and what it is not ─────────────────────────────────
# It stores a canonical owner-decision record with a SHA-256 CONTENT
# COMMITMENT, and refuses a decision whose bytes, identity coordinates, or
# independently supplied Runner-binding anchor do not match.
#
# That is an INTEGRITY check, not authentication. It does not prove who authored
# a record, and it is not an adversarial boundary against a hostile same-UID
# process — such a process can recompute any commitment this file can. It is not
# claimed to be otherwise anywhere in this subsystem, and the response fields it
# feeds say `hermetic_content_digest` rather than any authority word.
#
# It is a FIXTURE. It exists so the loopback rehearsal can prove `dispose`
# refuses a wrong, mismatched, tampered or replayed owner decision instead of
# accepting a shape. Production mutation stays structurally unavailable, so this
# prong deliberately builds no key material, no expiry, and no signing: those
# would be a production authorization system smuggled into a loopback
# prerequisite, and would advertise guarantees this contract does not make.
#
# ── Why this file does not wire the run journal ──────────────────────
# This subsystem is ADJACENT to the run journal, not part of it. It consumes a
# verified immutable anchor and has no way to query, append, replay, or control
# journal state: it holds no journal root, calls no journal helper, reads no
# claim, and writes no stage, claim, or index. Every journal-derived fact —
# the authorized root and the anchored Runner launch-binding digest — is
# RESOLVED BY THE FACADE and passed in as an immutable value.
#
# The façade suite's section W allowlist keeps that true: exactly three scripts/
# files wire the journal, and this is deliberately not a fourth. The prose here
# names the journal freely because section W reads EXECUTABLE text with comment
# bytes removed — a comment is not wiring.
#
# ── The trust chain this file sits inside ────────────────────────────
#   facade: authority gate + verified (task, generation) claim
#     -> immutable resolved inputs (this boundary)
#       -> record integrity + projection + replay checks (here)
#         -> allocator mutation exactly once (facade)
#
# The caller-supplied binding digest is NEVER the anchor. This file receives two
# distinct values — the CLI projection and the façade-resolved anchor — and
# compares them.
#
# ── Namespace ownership ──────────────────────────────────────────────
#   <owner-root>/owner-disposition/decisions/<id>.json  canonical + commitment
#   <owner-root>/owner-disposition/consumed/<id>.claim  single-use CAS claim

owner_disposition_schema() { printf 'oste-owner-disposition-decision/v1'; }

owner_disposition_area() { printf '%s/owner-disposition' "$1"; }
owner_disposition_path() { printf '%s/decisions/%s.json' "$(owner_disposition_area "$1")" "$2"; }
owner_disposition_consumed_path() { printf '%s/consumed/%s.claim' "$(owner_disposition_area "$1")" "$2"; }

# The production durable root, recomputed from the same XDG contract rather than
# imported, because importing it would make this a journal-wiring member. A test
# asserts the two definitions agree, so a drift is a failing test rather than a
# silent downgrade of the refusal below.
owner_disposition_production_root() {
	printf '%s/ghostty-launcher/runs' "${XDG_STATE_HOME:-${HOME}/.local/state}"
}

# Ids may not traverse: this grammar excludes `/` and `..`, so path construction
# cannot escape the area in the first place.
owner_disposition_id_is_valid() {
	[[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]
}

# The repository's digest convention: canonical `jq -S -c` bytes through
# `shasum -a 256`.
owner_disposition_commitment() {
	local canonical digest
	canonical=$(jq -S -c . <<<"${1:-}" 2>/dev/null) || return 1
	[[ -n "$canonical" && "$canonical" != "null" ]] || return 1
	digest=$(printf '%s' "$canonical" | shasum -a 256 | awk '{print $1}')
	[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$digest"
}

# The façade owns the authority PREDICATE; this owns CONTAINMENT. The two are
# complementary: a direct library caller that fabricates a root still cannot
# escape the checks here.
owner_disposition_root_is_usable() {
	local root="${1:-}" resolved prod prod_resolved
	_OWNER_DISPOSITION_REASON=""
	[[ -n "$root" && "$root" == /* ]] || {
		_OWNER_DISPOSITION_REASON="owner_root_not_absolute"
		return 2
	}
	prod=$(owner_disposition_production_root)
	# Production refusal FIRST, on the literal path, BEFORE any existence check.
	# A production root that does not happen to exist yet must still refuse in
	# production vocabulary; making it conditional on the directory existing
	# would silently degrade the strongest control here to a generic "unusable".
	if [[ "$root" == "$prod" || "$root" == "$prod"/* ]]; then
		_OWNER_DISPOSITION_REASON="production_root_refuses_owner_disposition"
		return 2
	fi
	[[ -d "$root" && ! -L "$root" ]] || {
		_OWNER_DISPOSITION_REASON="owner_root_unusable"
		return 2
	}
	resolved=$(cd "$root" 2>/dev/null && pwd -P) || {
		_OWNER_DISPOSITION_REASON="owner_root_unresolvable"
		return 2
	}
	# Second pass on the RESOLVED path, so a symlink into production is caught
	# as well as a literal match.
	prod_resolved="$prod"
	[[ -d "$prod" ]] && prod_resolved=$(cd "$prod" 2>/dev/null && pwd -P)
	if [[ "$resolved" == "$prod_resolved" || "$resolved" == "$prod_resolved"/* ]]; then
		_OWNER_DISPOSITION_REASON="production_root_refuses_owner_disposition"
		return 2
	fi
	printf '%s' "$resolved"
	return 0
}

# ── The canonical decision record ────────────────────────────────────
#
# Canonical bytes are produced exactly once and STORED, so verification compares
# stored bytes rather than re-canonicalizing a re-parsed object and hoping the
# two agree.
owner_disposition_canonical() {
	jq -S -cn \
		--arg schema "$(owner_disposition_schema)" \
		--arg proof_id "$1" --arg task_id "$2" --arg task_generation "$3" \
		--arg workspace_root "$4" --arg owner_identity_digest "$5" \
		--arg runner_binding_identity_digest "$6" --arg disposition "$7" \
		--arg actor "$8" --arg reason "$9" \
		'{schema:$schema, proof_id:$proof_id, task_id:$task_id,
		  task_generation:$task_generation, workspace_root:$workspace_root,
		  owner_identity_digest:$owner_identity_digest,
		  runner_binding_identity_digest:$runner_binding_identity_digest,
		  disposition:$disposition, actor:$actor, reason:$reason}'
}

# Write one owner-decision record. FIXTURE ONLY. Prints the commitment.
# Usage: owner_disposition_record ROOT ID TASK GEN WS ODIG BDIG DISP ACTOR REASON
owner_disposition_record() {
	local root="$1" canonical commitment path
	shift
	owner_disposition_root_is_usable "$root" >/dev/null || return 2
	owner_disposition_id_is_valid "$1" || {
		_OWNER_DISPOSITION_REASON="invalid_proof_id"
		return 3
	}
	canonical=$(owner_disposition_canonical "$@") || return 1
	commitment=$(owner_disposition_commitment "$canonical") || return 1
	path=$(owner_disposition_path "$root" "$1")
	mkdir -p "$(dirname "$path")" 2>/dev/null || return 1
	(umask 077 && jq -cn --arg payload "$canonical" --arg commitment "$commitment" \
		'{payload:$payload, commitment:$commitment}' >"$path") || return 1
	printf '%s' "$commitment"
	return 0
}

# ── Verification ─────────────────────────────────────────────────────
#
# Flag-based because the input list is long and explicit by design: removing the
# environment-global journal dependency is the point of this boundary.
#
#   --root R --proof-id P --task-id T --generation G --workspace W
#   --owner-identity-digest D --cli-binding-digest CD
#   --anchored-binding-digest AD --actor A --reason X [--cli-digest S]
#
# Prints the stored canonical record and returns 0, or sets
# _OWNER_DISPOSITION_REASON and returns non-zero. Every check precedes any
# allocator mutation, which the façade performs.
owner_disposition_verify() {
	local root="" proof_id="" task_id="" generation="" workspace_root=""
	local owner_digest="" cli_binding="" anchored_binding="" actor="" reason="" cli_digest=""
	local resolved area_resolved path path_parent doc payload commitment recomputed
	local field want got
	_OWNER_DISPOSITION_REASON=""

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--root) root="$2" ;;
			--proof-id) proof_id="$2" ;;
			--task-id) task_id="$2" ;;
			--generation) generation="$2" ;;
			--workspace) workspace_root="$2" ;;
			--owner-identity-digest) owner_digest="$2" ;;
			--cli-binding-digest) cli_binding="$2" ;;
			--anchored-binding-digest) anchored_binding="$2" ;;
			--actor) actor="$2" ;;
			--reason) reason="$2" ;;
			--cli-digest) cli_digest="$2" ;;
			*)
				_OWNER_DISPOSITION_REASON="verifier_unknown_input"
				return 3
				;;
		esac
		shift 2
	done

	# 1. Structural root gate, independent of any caller assertion.
	resolved=$(owner_disposition_root_is_usable "$root") || return 2

	# The anchor must be supplied and well-shaped. Its ABSENCE is a refusal, not
	# a reason to fall back to the caller's own digest.
	[[ "$anchored_binding" =~ ^[0-9a-f]{64}$ ]] || {
		_OWNER_DISPOSITION_REASON="runner_binding_unanchored"
		return 3
	}

	# 2. Locate the record without traversing or following a symlink.
	owner_disposition_id_is_valid "$proof_id" || {
		_OWNER_DISPOSITION_REASON="invalid_proof_id"
		return 3
	}
	path=$(owner_disposition_path "$resolved" "$proof_id")
	[[ -e "$path" ]] || {
		_OWNER_DISPOSITION_REASON="proof_not_found"
		return 3
	}
	[[ -f "$path" && ! -L "$path" ]] || {
		_OWNER_DISPOSITION_REASON="proof_symlink_refused"
		return 3
	}
	area_resolved=$(cd "$(owner_disposition_area "$resolved")" 2>/dev/null && pwd -P) || {
		_OWNER_DISPOSITION_REASON="owner_root_unusable"
		return 2
	}
	path_parent=$(cd "$(dirname "$path")" 2>/dev/null && pwd -P) || {
		_OWNER_DISPOSITION_REASON="proof_not_found"
		return 3
	}
	[[ "$path_parent" == "$area_resolved"/* || "$path_parent" == "$area_resolved" ]] || {
		_OWNER_DISPOSITION_REASON="proof_escapes_authorized_root"
		return 3
	}

	# 3. Shape.
	doc=$(cat "$path" 2>/dev/null) || {
		_OWNER_DISPOSITION_REASON="proof_unreadable"
		return 3
	}
	payload=$(jq -r 'if type == "object" then (.payload // empty) else empty end' <<<"$doc" 2>/dev/null)
	commitment=$(jq -r 'if type == "object" then (.commitment // empty) else empty end' <<<"$doc" 2>/dev/null)
	[[ -n "$payload" && "$commitment" =~ ^[0-9a-f]{64}$ ]] || {
		_OWNER_DISPOSITION_REASON="proof_malformed"
		return 3
	}
	jq -e --arg schema "$(owner_disposition_schema)" '
		type == "object" and .schema == $schema
		and (.proof_id | type == "string") and (.task_id | type == "string")
		and (.task_generation | type == "string") and (.workspace_root | type == "string")
		and (.owner_identity_digest | test("^[0-9a-f]{64}$"))
		and (.runner_binding_identity_digest | test("^[0-9a-f]{64}$"))
		and (.disposition == "release")
		and (.actor | type == "string") and (.reason | type == "string")' \
		>/dev/null 2>&1 <<<"$payload" || {
		_OWNER_DISPOSITION_REASON="proof_malformed"
		return 3
	}

	# 4. Content commitment over the EXACT stored bytes.
	recomputed=$(owner_disposition_commitment "$payload") || {
		_OWNER_DISPOSITION_REASON="proof_commitment_uncomputable"
		return 3
	}
	[[ "$recomputed" == "$commitment" ]] || {
		_OWNER_DISPOSITION_REASON="proof_commitment_mismatch"
		return 3
	}
	if [[ -n "$cli_digest" && "$cli_digest" != "$commitment" ]]; then
		_OWNER_DISPOSITION_REASON="proof_projection_mismatch:digest"
		return 3
	fi

	# 5. Every CLI projection must equal the stored record.
	for field in proof_id:$proof_id task_id:$task_id task_generation:$generation \
		owner_identity_digest:$owner_digest \
		runner_binding_identity_digest:$cli_binding \
		actor:$actor; do
		want="${field%%:*}"
		got=$(jq -r --arg k "$want" '.[$k]' <<<"$payload")
		[[ "$got" == "${field#*:}" ]] || {
			_OWNER_DISPOSITION_REASON="proof_projection_mismatch:${want}"
			return 3
		}
	done
	[[ "$(jq -r '.reason' <<<"$payload")" == "$reason" ]] || {
		_OWNER_DISPOSITION_REASON="proof_projection_mismatch:reason"
		return 3
	}

	# 6. THE anchor comparison. The stored binding must equal the digest the
	#    façade independently resolved. A caller-supplied digest is never the
	#    anchor, however well-shaped.
	[[ "$(jq -r '.runner_binding_identity_digest' <<<"$payload")" == "$anchored_binding" ]] || {
		_OWNER_DISPOSITION_REASON="runner_binding_mismatch"
		return 3
	}

	# 7. Workspace identity. `--workspace-root` is a selector to verify, never
	#    authority.
	[[ "$(jq -r '.workspace_root' <<<"$payload")" == "$workspace_root" ]] || {
		_OWNER_DISPOSITION_REASON="workspace_identity_mismatch"
		return 3
	}

	printf '%s' "$payload"
	return 0
}

# ── Single-use consumption (hard-link test-and-set) ──────────────────
#
# The same lock-free primitive the journal's exclusive claim uses, for the same
# reason: `ln` lands the claim's CONTENT atomically, where a bare mkdir leaves a
# window in which the slot is taken but unattributable. Same technique, separate
# namespace — this writes no journal state.
#
# 0 = claimed (allocator may run exactly once)
# 4 = already consumed by a BYTE-IDENTICAL identity (idempotent, non-mutating)
# 5 = already consumed by a DIFFERENT identity (conflict)
owner_disposition_consume() {
	local root="$1" proof_id="$2" identity="$3" path tmp existing want
	path=$(owner_disposition_consumed_path "$root" "$proof_id")
	mkdir -p "$(dirname "$path")" 2>/dev/null || return 1
	want=$(jq -S -c . <<<"$identity" 2>/dev/null) || return 1
	if [[ -e "$path" ]]; then
		[[ -f "$path" && ! -L "$path" ]] || return 1
		existing=$(jq -S -c '.identity' "$path" 2>/dev/null)
		[[ "$existing" == "$want" ]] && return 4
		return 5
	fi
	tmp=$(mktemp "${path}.tmp.XXXXXX") || return 1
	if ! (umask 077 && jq -cn --arg id "$proof_id" --argjson identity "$identity" \
		--arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		'{schema:"oste-owner-disposition-consumed/v1", proof_id:$id,
		  identity:$identity, consumed_at:$at, outcome:"claimed_pending_allocator"}' >"$tmp"); then
		rm -f "$tmp"
		return 1
	fi
	if ln "$tmp" "$path" 2>/dev/null; then
		rm -f "$tmp"
		return 0
	fi
	rm -f "$tmp"
	existing=$(jq -S -c '.identity' "$path" 2>/dev/null)
	[[ "$existing" == "$want" ]] && return 4
	return 5
}

# Record the terminal outcome against a consumed claim. The claim is NEVER
# deleted or freed on failure: a decision consumed before an allocator call that
# then failed stays fail-closed and reconstructable, so an owner sees what was
# attempted rather than a slot that quietly became reusable.
owner_disposition_record_outcome() {
	local root="$1" proof_id="$2" outcome="$3" path tmp
	path=$(owner_disposition_consumed_path "$root" "$proof_id")
	[[ -f "$path" ]] || return 1
	tmp=$(mktemp "${path}.out.XXXXXX") || return 1
	if jq -c --arg o "$outcome" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		'.outcome = $o | .settled_at = $at' "$path" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$path" && return 0
	fi
	rm -f "$tmp"
	return 1
}

owner_disposition_consumed_outcome() {
	jq -r '.outcome // empty' "$(owner_disposition_consumed_path "$1" "$2")" 2>/dev/null
}
