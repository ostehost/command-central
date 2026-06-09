#!/bin/bash
#
# backend-commands.sh — Build agent CLI commands for all supported backends
#
# Centralizes command construction for claude, gemini, codex, acp, acp-codex, and acp-gemini backends.
# Sourced by oste-spawn.sh to eliminate duplicated command-building logic.
#

# Build the agent CLI command string for the given backend and mode.
#
# Usage: build_agent_command <options...>
#   --backend <claude|gemini|codex|acp|acp-codex|acp-gemini>  Agent CLI backend (required)
#   --prompt-file <path>             Path to prompt file (required)
#   --task-id <id>                   Task identifier (required for stream sidecars)
#   --model <model>                  Model override (optional)
#   --thinking-budget <tokens>       Legacy thinking budget tokens, Claude only (optional; prefer --effort)
#   OSTE_CLAUDE_EFFORT                 Claude effort level; defaults to xhigh (valid: low, medium, high, xhigh, max)
#   --max-turns <N>                  Max agentic turns, Claude only (optional)
#   --interactive                    Interactive TUI mode; required for Claude
#   --project-dir <path>             Project directory (for codex git check)
#   --script-dir <path>              Scripts directory (for formatter lookup)
#
# Outputs: the backend-specific agent command string to stdout.
# Runtime PATH initialization is injected by oste-spawn.sh so it can be
# sourced from a temp file instead of inlined into terminal_send payloads.

# Build a shell snippet that refreshes PATH from the user's shell init files
# at command runtime instead of relying on whatever PATH was baked into the
# launcher bundle when it was created.
build_runtime_path_prefix() {
	cat <<'EOF'
__oste_runtime_path_init() {
	local _oste_original_path _oste_entry _oste_shell_name _oste_effective_shell_name _oste_zdotdir _oste_old_ifs
	_oste_original_path="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
	PATH="/usr/bin:/bin:/usr/sbin:/sbin"
	export PATH

	__oste_source_if_exists() {
		[[ -f "$1" ]] || return 0
		. "$1"
	}

	__oste_path_prepend() {
		local _oste_dir="$1"
		[[ -n "$_oste_dir" ]] || return 0
		case ":${PATH}:" in
			*":${_oste_dir}:"*) ;;
			*) PATH="${_oste_dir}:${PATH}" ;;
		esac
	}

	__oste_path_append() {
		local _oste_dir="$1"
		[[ -n "$_oste_dir" ]] || return 0
		case ":${PATH}:" in
			*":${_oste_dir}:"*) ;;
			*) PATH="${PATH}:${_oste_dir}" ;;
		esac
	}

	_oste_zdotdir="${ZDOTDIR:-${HOME}}"
	_oste_shell_name="${SHELL##*/}"
	if [[ -n "${BASH_VERSION:-}" ]]; then
		_oste_effective_shell_name="bash"
	elif [[ -n "${ZSH_VERSION:-}" ]]; then
		_oste_effective_shell_name="zsh"
	else
		_oste_effective_shell_name="${_oste_shell_name}"
	fi
	case "${_oste_effective_shell_name}" in
		zsh)
			__oste_source_if_exists "${_oste_zdotdir}/.zprofile"
			__oste_source_if_exists "${_oste_zdotdir}/.zshrc"
			;;
		bash)
			__oste_source_if_exists "${HOME}/.bash_profile"
			__oste_source_if_exists "${HOME}/.bashrc"
			__oste_source_if_exists "${HOME}/.profile"
			;;
		*)
			__oste_source_if_exists "${HOME}/.profile"
			;;
	esac

	__oste_path_prepend "${HOME}/.bun/bin"
	__oste_path_prepend "${HOME}/.local/bin"
	__oste_path_prepend "/opt/homebrew/sbin"
	__oste_path_prepend "/opt/homebrew/bin"

	_oste_old_ifs="$IFS"
	IFS=':'
	for _oste_entry in ${_oste_original_path}; do
		[[ -n "${_oste_entry}" ]] || continue
		__oste_path_append "${_oste_entry}"
	done
	IFS="${_oste_old_ifs}"

	__oste_path_append "/usr/local/bin"
	__oste_path_append "/usr/local/sbin"
	__oste_path_append "/usr/bin"
	__oste_path_append "/bin"
	__oste_path_append "/usr/sbin"
	__oste_path_append "/sbin"

	export PATH
	unset _oste_original_path _oste_entry _oste_shell_name _oste_effective_shell_name _oste_zdotdir _oste_old_ifs
	unset -f __oste_source_if_exists __oste_path_prepend __oste_path_append
}
__oste_runtime_path_init && unset -f __oste_runtime_path_init
EOF
}

build_agent_command() {
	local backend=""
	local prompt_file=""
	local task_id=""
	local model=""
	local thinking_budget=""
	local max_turns=""
	local interactive=""
	local project_dir=""
	local script_dir=""
	# Pre-generated claude session UUID. When supplied for the claude backend
	# (only), gets passed through as `--session-id <uuid>` so the conversation
	# is created with a known identifier — the same one the task registry
	# records — letting the IDE resume the exact conversation later.
	local session_id=""

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--backend)
				backend="$2"
				shift 2
				;;
			--prompt-file)
				prompt_file="$2"
				shift 2
				;;
			--task-id)
				task_id="$2"
				shift 2
				;;
			--model)
				model="$2"
				shift 2
				;;
			--thinking-budget)
				thinking_budget="$2"
				shift 2
				;;
			--max-turns)
				max_turns="$2"
				shift 2
				;;
			--interactive)
				interactive=1
				shift
				;;
			--project-dir)
				project_dir="$2"
				shift 2
				;;
			--script-dir)
				script_dir="$2"
				shift 2
				;;
			--session-id)
				session_id="$2"
				shift 2
				;;
			*)
				echo "build_agent_command: unknown option: $1" >&2
				return 1
				;;
		esac
	done

	[[ -n "$backend" ]] || {
		echo "build_agent_command: --backend is required" >&2
		return 1
	}
	[[ -n "$prompt_file" ]] || {
		echo "build_agent_command: --prompt-file is required" >&2
		return 1
	}

	# Guard: strip incompatible models per backend.
	# Codex only accepts OpenAI models; Claude models cause instant 400 errors.
	local effective_model="$model"
	if [[ "$backend" == "codex" || "$backend" == "acp-codex" ]]; then
		case "$effective_model" in
			claude-* | anthropic/*)
				echo "build_agent_command: WARNING: skipping incompatible model '${effective_model}' for ${backend} backend" >&2
				effective_model=""
				;;
		esac
	elif [[ "$backend" == "gemini" || "$backend" == "acp-gemini" ]]; then
		case "$effective_model" in
			claude-* | anthropic/* | gpt-* | o1-* | o3-* | openai/*)
				echo "build_agent_command: WARNING: skipping incompatible model '${effective_model}' for ${backend} backend" >&2
				effective_model=""
				;;
		esac
	fi

	local model_flag=""
	if [[ -n "$effective_model" ]]; then
		model_flag=" --model '${effective_model}'"
	fi

	local max_turns_flag=""
	if [[ -n "$max_turns" ]] && [[ "$backend" == "claude" ]]; then
		max_turns_flag=" --max-turns ${max_turns}"
	fi

	local thinking_budget_flag=""
	if [[ -n "$thinking_budget" ]] && [[ "$backend" == "claude" ]]; then
		thinking_budget_flag=" --thinking-budget ${thinking_budget}"
	fi

	local effort_flag=""
	if [[ "$backend" == "claude" ]]; then
		local claude_effort="${OSTE_CLAUDE_EFFORT:-xhigh}"
		if [[ -n "$claude_effort" ]]; then
			case "$claude_effort" in
				low | medium | high | xhigh | max)
					effort_flag=" --effort '${claude_effort}'"
					;;
				*)
					echo "build_agent_command: invalid OSTE_CLAUDE_EFFORT (expected: low, medium, high, xhigh, max)" >&2
					return 1
					;;
			esac
		fi
	fi

	# Wire the pre-generated session UUID through to claude. Only applies to
	# the claude backend — codex and gemini don't have an equivalent flag.
	local session_id_flag=""
	if [[ -n "$session_id" ]] && [[ "$backend" == "claude" ]]; then
		session_id_flag=" --session-id '${session_id}'"
	fi

	# Stream file prefix differs by backend
	local stream_prefix
	case "$backend" in
		gemini) stream_prefix="gemini-stream" ;;
		codex) stream_prefix="codex-stream" ;;
		acp-codex) stream_prefix="acp-codex-stream" ;;
		acp-gemini) stream_prefix="acp-gemini-stream" ;;
		*) stream_prefix="claude-stream" ;;
	esac

	local stream_file="/tmp/${stream_prefix}-${task_id}.jsonl"
	local stderr_log="/tmp/${backend}-stderr-${task_id}.log"
	local formatter="${script_dir}/lib/stream-formatter.py"

	local cmd
	case "$backend" in
		acp)
			# ACP wraps claude via acpx — always interactive (visible terminal).
			# --approve-all enables autonomous mode. --format text for readable output.
			cmd="acpx --approve-all  --cwd \"\${project_dir}\" claude exec \"\$(cat '${prompt_file}')\"${model_flag}"
			;;
		acp-codex)
			# ACP wraps codex via acpx — always interactive (visible terminal).
			cmd="acpx --approve-all  --cwd \"\${project_dir}\" codex exec \"\$(cat '${prompt_file}')\"${model_flag}"
			;;
		acp-gemini)
			# ACP wraps gemini via acpx — always interactive (visible terminal).
			cmd="acpx --approve-all  --cwd \"\${project_dir}\" gemini exec \"\$(cat '${prompt_file}')\"${model_flag}"
			;;
		gemini)
			if [[ -n "$interactive" ]]; then
				cmd="gemini \"\$(cat '${prompt_file}')\" --approval-mode yolo${model_flag}"
			else
				if [[ -n "$script_dir" ]] && [[ -x "$formatter" ]]; then
					cmd="gemini -p \"\$(cat '${prompt_file}')\" --approval-mode yolo --output-format stream-json${model_flag} 2>>'${stderr_log}' | tee '${stream_file}' | '${formatter}'"
				else
					cmd="gemini -p \"\$(cat '${prompt_file}')\" --approval-mode yolo --output-format stream-json${model_flag} 2>>'${stderr_log}' | tee '${stream_file}'"
				fi
			fi
			;;
		codex)
			# Keep Codex sandboxed but explicitly allow git metadata writes.
			# Without .git in writable roots, git can fail on .git/index.lock.
			local codex_workspace_flags=""
			if [[ -n "$project_dir" ]]; then
				codex_workspace_flags=" --cd '${project_dir}' --add-dir '${project_dir}/.git'"
			fi
			local codex_repo_flag=""
			if [[ -n "$project_dir" ]] && ! git -C "${project_dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
				codex_repo_flag=" --skip-git-repo-check"
			fi
			if [[ -n "$interactive" ]]; then
				cmd="cat '${prompt_file}' | codex -a never${model_flag}${codex_workspace_flags} -"
			else
				if [[ -n "$script_dir" ]] && [[ -x "$formatter" ]]; then
					cmd="cat '${prompt_file}' | codex exec --json --full-auto${model_flag}${codex_workspace_flags}${codex_repo_flag} - 2>>'${stderr_log}' | tee '${stream_file}' | '${formatter}'"
				else
					cmd="cat '${prompt_file}' | codex exec --json --full-auto${model_flag}${codex_workspace_flags}${codex_repo_flag} - 2>>'${stderr_log}' | tee '${stream_file}'"
				fi
			fi
			;;
		claude | *)
			if [[ -n "$interactive" ]]; then
				cmd="claude \"\$(cat '${prompt_file}')\" --dangerously-skip-permissions --chrome${session_id_flag}${model_flag}${max_turns_flag}${thinking_budget_flag}${effort_flag}"
			else
				echo "build_agent_command: Claude launcher lanes require --interactive; refusing print mode" >&2
				return 1
			fi
			;;
	esac

	echo "${cmd}"
}
