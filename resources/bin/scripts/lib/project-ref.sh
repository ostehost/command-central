#!/bin/bash
#
# project-ref.sh — Registry-backed project identity (Work System LaneRef)
#
# Resolves spawn-time project identity through the canonical Work Registry
# resolver (oc-project.mjs) instead of inventing it from paths, worktree
# dirnames, or session names. The launcher stays a lane runner: it consumes
# ProjectRef JSON; it never owns registry data.
#
# Resolver contract (oc-project.mjs):
#   resolve --path <p>  -> ProjectRef JSON on stdout
#   exit 0 resolved, 1 unresolved, 2 usage/load error, 3 ambiguous
#
# Configuration (env):
#   OSTE_PROJECT_RESOLVER   resolver path (default: canonical config main).
#                           *.mjs/*.js run via node; anything else executes
#                           directly (lets tests inject shell fixtures).
#   OSTE_PROJECT_REGISTRY   optional --registry override (fixture registries)
#   OSTE_PROJECT_CONDUCTOR  optional --conductor override
#   OSTE_LANE_KIND          explicit lane kind override (validated)

readonly OSTE_PROJECT_RESOLVER_DEFAULT="/Users/ostehost/projects/config/openclaw/scripts/oc-project.mjs"
readonly OSTE_VALID_LANE_KINDS="implementation review research release-proof"

project_ref_resolver() {
	printf '%s' "${OSTE_PROJECT_RESOLVER:-$OSTE_PROJECT_RESOLVER_DEFAULT}"
}

# Resolution is on by default. Two explicit opt-outs exist:
#   OSTE_PROJECT_RESOLUTION=0 — kill switch. Exported by test/lib/test-helpers.sh
#     so suites exercising the real spawn/completion path with ad-hoc /tmp
#     project dirs do not fail closed as "unregistered".
#   OSTE_TEST_MODE=1 without an injected resolver — same rationale for spawns
#     launched in test mode outside the shared helpers.
# Real launches never set either, so production spawns always resolve.
project_ref_resolution_enabled() {
	[[ "${OSTE_PROJECT_RESOLUTION:-1}" != "0" ]] || return 1
	if [[ "${OSTE_TEST_MODE:-}" == "1" && -z "${OSTE_PROJECT_RESOLVER:-}" ]]; then
		return 1
	fi
	return 0
}

# Run the resolver for a path. Echoes resolver stdout (ProjectRef JSON or
# error JSON) and propagates the resolver exit code:
#   0 resolved, 1 unresolved, 2 resolver unavailable/error, 3 ambiguous
project_ref_resolve() {
	local path="$1"
	local resolver
	resolver=$(project_ref_resolver)
	[[ -f "$resolver" ]] || {
		printf '{"error":"project resolver not found","resolver":"%s"}\n' "$resolver"
		return 2
	}
	local -a cmd
	case "$resolver" in
		*.mjs | *.js)
			command -v node >/dev/null 2>&1 || {
				printf '{"error":"node not available for project resolver"}\n'
				return 2
			}
			cmd=(node "$resolver")
			;;
		*) cmd=("$resolver") ;;
	esac
	cmd+=(resolve --path "$path")
	[[ -n "${OSTE_PROJECT_REGISTRY:-}" ]] && cmd+=(--registry "$OSTE_PROJECT_REGISTRY")
	[[ -n "${OSTE_PROJECT_CONDUCTOR:-}" ]] && cmd+=(--conductor "$OSTE_PROJECT_CONDUCTOR")
	"${cmd[@]}" 2>/dev/null
}

project_ref_valid_lane_kind() {
	local kind="${1:-}"
	local k
	for k in $OSTE_VALID_LANE_KINDS; do
		[[ "$k" == "$kind" ]] && return 0
	done
	return 1
}

# Map launcher role -> lane kind. Explicit kind (flag, then OSTE_LANE_KIND)
# wins over the role mapping; every result is validated.
project_ref_lane_kind() {
	local role="${1:-}"
	local explicit="${2:-${OSTE_LANE_KIND:-}}"
	local kind
	if [[ -n "$explicit" ]]; then
		kind="$explicit"
	else
		case "$role" in
			reviewer) kind="review" ;;
			planner) kind="research" ;;
			*) kind="implementation" ;; # developer, test, unset
		esac
	fi
	project_ref_valid_lane_kind "$kind" || return 1
	printf '%s' "$kind"
}

# Slim project_ref record persisted into tasks.json. Carries the canonical
# identity fields consumers (Command Central, audit) need without copying
# the full registry row.
project_ref_record_registered() {
	local resolver_json="$1"
	jq -c '{
		id: .id,
		displayName: (.displayName // null),
		status: "registered",
		registry_status: (.status // null),
		repoOrigins: (.repoOrigins // []),
		lanePolicy: (.lanePolicy // null),
		resolution: (.resolution // null)
	}' <<<"$resolver_json"
}

project_ref_record_unregistered() {
	local input_path="$1"
	local reason="${2:-unresolved}"
	jq -cn --arg input "$input_path" --arg reason "$reason" '{
		id: null,
		status: "unregistered",
		reason: $reason,
		resolution: {method: "unresolved", input: $input, detail: null}
	}'
}

# Canonical project directory for this host: the first registry path that
# exists locally, falling back to the canonical-path resolution detail.
# Echoes empty when nothing matches (caller falls back to execution dir).
project_ref_canonical_dir() {
	local resolver_json="$1"
	local candidate
	while IFS= read -r candidate; do
		[[ -n "$candidate" && -d "$candidate" ]] || continue
		printf '%s' "$candidate"
		return 0
	done < <(jq -r '[
		.paths.node, .paths.hub,
		(if (.resolution.method // "") == "canonical-path" then .resolution.detail else null end)
	] | map(select(. != null)) | .[]' <<<"$resolver_json" 2>/dev/null)
	return 0
}

# Count running lanes already carrying this canonical project id. Reads the
# task registry without taking the tasks lock: spawn-time admission is an
# advisory read; authoritative registration happens under lock_tasks.
project_ref_count_active_lanes() {
	local tasks_file="$1"
	local project_id="$2"
	local exclude_task_id="${3:-}"
	[[ -f "$tasks_file" ]] || {
		printf '0'
		return 0
	}
	jq -r --arg pid "$project_id" --arg exclude "$exclude_task_id" '
		[.tasks // {} | to_entries[]
			| select(.key != $exclude)
			| select(.value.status == "running")
			| select((.value.project_id // "") == $pid)
		] | length' "$tasks_file" 2>/dev/null || printf '0'
}

# approvedKinds admission: fail-closed when the registry declares a policy
# that does not include this lane kind. Echoes the approved list on failure.
project_ref_check_approved_kind() {
	local resolver_json="$1"
	local lane_kind="$2"
	local approved
	approved=$(jq -r '.lanePolicy.approvedKinds // empty | join(",")' <<<"$resolver_json" 2>/dev/null || true)
	[[ -n "$approved" ]] || return 0
	local IFS=','
	local k
	for k in $approved; do
		[[ "$k" == "$lane_kind" ]] && return 0
	done
	printf '%s' "$approved"
	return 1
}

# maxActiveLanes admission. Echoes a human-readable reason on failure.
project_ref_check_max_lanes() {
	local resolver_json="$1"
	local project_id="$2"
	local tasks_file="$3"
	local exclude_task_id="${4:-}"
	local max
	max=$(jq -r '.lanePolicy.maxActiveLanes // empty' <<<"$resolver_json" 2>/dev/null || true)
	[[ "$max" =~ ^[0-9]+$ ]] || return 0
	local active
	active=$(project_ref_count_active_lanes "$tasks_file" "$project_id" "$exclude_task_id")
	if ((active >= max)); then
		printf 'maxActiveLanes exceeded for project %s: %s running lane(s), policy allows %s' \
			"$project_id" "$active" "$max"
		return 1
	fi
	return 0
}
