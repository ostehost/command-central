#!/bin/bash
# spawn-lease.sh - short-lived launch lease for host/project routing
#
# Serializes the spawn critical section for a {project, node, mode} tuple so
# concurrent launches cannot race terminal/session identity before tasks.json is
# registered. The lease is intentionally released after registration succeeds;
# long-running task ownership remains represented by tasks.json/session checks.

spawn_lease_dir() {
	printf '%s' "${OSTE_SPAWN_LEASE_DIR:-/tmp/ghostty-launcher-spawn-leases}"
}

spawn_lease_canonical_project() {
	local project_dir="$1"
	if [[ -d "$project_dir" ]]; then
		local origin_url top_level resolved_project_dir
		top_level=$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null || true)
		resolved_project_dir=$(cd "$project_dir" 2>/dev/null && pwd -P) || resolved_project_dir=""
		origin_url=$(git -C "$project_dir" remote get-url origin 2>/dev/null || true)
		if [[ -n "$origin_url" && -n "$top_level" && "$resolved_project_dir" == "$top_level" ]]; then
			printf 'git:%s' "$origin_url"
			return 0
		fi
	fi
	if [[ -d "$project_dir" ]]; then
		(cd "$project_dir" 2>/dev/null && pwd -P) || printf '%s' "$project_dir"
	else
		printf '%s' "$project_dir"
	fi
}

spawn_lease_hash() {
	local material="$1"
	if command -v shasum >/dev/null 2>&1; then
		printf '%s' "$material" | shasum -a 256 | awk '{print $1}'
	elif command -v sha256sum >/dev/null 2>&1; then
		printf '%s' "$material" | sha256sum | awk '{print $1}'
	else
		printf '%s' "$material" | cksum | awk '{print $1}'
	fi
}

spawn_lease_key() {
	local project_dir="$1"
	local exec_mode="${2:-hub}"
	local exec_node="${3:-}"
	local project_key
	project_key=$(spawn_lease_canonical_project "$project_dir")
	[[ -n "$exec_node" ]] || exec_node="local"
	spawn_lease_hash "mode=${exec_mode}
node=${exec_node}
project=${project_key}"
}

spawn_lease_path() {
	local project_dir="$1"
	local exec_mode="${2:-hub}"
	local exec_node="${3:-}"
	local key
	key=$(spawn_lease_key "$project_dir" "$exec_mode" "$exec_node")
	printf '%s/%s.lock' "$(spawn_lease_dir)" "$key"
}

_spawn_lease_mtime() {
	local path="$1"
	stat -f %m "$path" 2>/dev/null || stat -c %Y "$path" 2>/dev/null || echo 0
}

_spawn_lease_remove_dir() {
	local lease_path="$1"
	case "$lease_path" in
		/tmp/* | /private/tmp/*) rm -rf "$lease_path" 2>/dev/null || true ;;
		*)
			rm -f "${lease_path}/pid" "${lease_path}/meta" 2>/dev/null || true
			rmdir "$lease_path" 2>/dev/null || true
			;;
	esac
}

_spawn_lease_remove_if_stale() {
	local lease_path="$1"
	local stale_age="$2"
	[[ -d "$lease_path" ]] || return 0

	local pid_file="${lease_path}/pid"
	if [[ -f "$pid_file" ]]; then
		local held_pid
		held_pid=$(cat "$pid_file" 2>/dev/null || true)
		if [[ -n "$held_pid" ]] && ! kill -0 "$held_pid" 2>/dev/null; then
			echo "Warning: removing spawn lease held by dead PID ${held_pid}" >&2
			_spawn_lease_remove_dir "$lease_path"
			return 0
		fi
	fi

	local mtime now age
	mtime=$(_spawn_lease_mtime "$lease_path")
	now=$(date +%s)
	age=$((now - mtime))
	if [[ $age -ge $stale_age ]]; then
		echo "Warning: removing stale spawn lease (age: ${age}s)" >&2
		_spawn_lease_remove_dir "$lease_path"
	fi
}

spawn_lease_acquire() {
	local project_dir="$1"
	local exec_mode="${2:-hub}"
	local exec_node="${3:-}"
	local task_id="${4:-unknown}"
	local max_wait="${OSTE_SPAWN_LEASE_MAX_WAIT:-10}"
	local stale_age="${OSTE_SPAWN_LEASE_STALE_AGE:-120}"
	local lease_root lease_path waited

	lease_root=$(spawn_lease_dir)
	mkdir -p "$lease_root"
	lease_path=$(spawn_lease_path "$project_dir" "$exec_mode" "$exec_node")
	waited=0

	while true; do
		if mkdir "$lease_path" 2>/dev/null; then
			{
				printf 'pid=%s\n' "$$"
				printf 'task_id=%s\n' "$task_id"
				printf 'exec_mode=%s\n' "$exec_mode"
				printf 'exec_node=%s\n' "${exec_node:-local}"
				printf 'project_dir=%s\n' "$(spawn_lease_canonical_project "$project_dir")"
				printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
			} >"${lease_path}/meta"
			printf '%s\n' "$$" >"${lease_path}/pid"
			printf '%s\n' "$lease_path"
			return 0
		fi

		_spawn_lease_remove_if_stale "$lease_path" "$stale_age"
		sleep 0.1
		waited=$((waited + 1))
		if [[ $waited -ge $((max_wait * 10)) ]]; then
			echo "Error: spawn lease timeout for ${project_dir} (${exec_mode}/${exec_node:-local}) after ${max_wait}s" >&2
			return 1
		fi
	done
}

spawn_lease_release() {
	local lease_path="${1:-}"
	[[ -n "$lease_path" ]] || return 0
	case "$lease_path" in
		"$(spawn_lease_dir)"/*) _spawn_lease_remove_dir "$lease_path" ;;
		*) echo "Warning: refusing to release spawn lease outside lease dir: ${lease_path}" >&2 ;;
	esac
}
