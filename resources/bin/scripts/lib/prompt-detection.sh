#!/bin/bash
#
# prompt-detection.sh — Shared shell prompt heuristics
#
# Keep prompt detection centralized so tmux reuse, persist, and other terminal
# backends agree on what "ready for the next command" means.
#

[[ -n "${_PROMPT_DETECTION_SH_LOADED:-}" ]] && return 0
readonly _PROMPT_DETECTION_SH_LOADED=1

terminal_normalize_line() {
	local line="$1"
	line="${line//$'\r'/}"
	line=$(printf '%s' "$line" | sed -E $'s/\x1B\\[[0-9;?]*[ -/]*[@-~]//g; s/\x1B\\][^\a]*(\a|\x1B\\\\)//g')
	line="${line#"${line%%[![:space:]]*}"}"
	line="${line%"${line##*[![:space:]]}"}"
	printf '%s' "$line"
}

terminal_last_visible_line() {
	local output="$1"
	local line
	local -a lines=()

	while IFS= read -r line || [[ -n "$line" ]]; do
		lines+=("$line")
	done <<<"$output"

	local idx normalized
	for ((idx = ${#lines[@]} - 1; idx >= 0; idx--)); do
		normalized=$(terminal_normalize_line "${lines[idx]}")
		if [[ -n "$normalized" ]]; then
			printf '%s' "$normalized"
			return 0
		fi
	done

	return 1
}

terminal_last_visible_joined() {
	local output="$1"
	local max_lines="${2:-2}"
	local line normalized joined=""
	local -a lines=()
	local count=0

	while IFS= read -r line || [[ -n "$line" ]]; do
		lines+=("$line")
	done <<<"$output"

	local idx
	for ((idx = ${#lines[@]} - 1; idx >= 0; idx--)); do
		normalized=$(terminal_normalize_line "${lines[idx]}")
		if [[ -n "$normalized" ]]; then
			joined="${normalized}${joined}"
			count=$((count + 1))
			if ((count >= max_lines)); then
				break
			fi
		fi
	done

	[[ -n "$joined" ]] || return 1
	printf '%s' "$joined"
}

terminal_output_ends_at_prompt() {
	local output="$1"
	local line
	line=$(terminal_last_visible_line "$output") || return 1
	if terminal_line_looks_like_prompt "$line"; then
		return 0
	fi

	line=$(terminal_last_visible_joined "$output" 2) || return 1
	terminal_line_looks_like_prompt "$line"
}

terminal_line_looks_like_prompt() {
	local line="$1"
	line=$(terminal_normalize_line "$line")
	[[ -n "$line" ]] || return 1

	# Bare prompt glyphs: sh/zsh root/user, Powerlevel10k, fish root prompt.
	if printf '%s\n' "$line" | grep -qE '^[[:space:]]*([#$%]|❯|›|>)$'; then
		return 0
	fi

	# Common prompts with a space-delimited prompt char, e.g.
	# "user@host repo %", "~/repo ❯", "container #".
	if printf '%s\n' "$line" | grep -qE '^[^[:cntrl:]]+[[:space:]]([#$%]|❯|›)$'; then
		return 0
	fi

	# Compact prompts without a separating space, e.g. "bash-3.2$" or "~/repo>".
	if printf '%s\n' "$line" | grep -qE '^[~[:alnum:]_./:@()+-]+([#$%]|>)$'; then
		return 0
	fi

	# Two-token prompts where the final segment carries the prompt char, e.g.
	# "Mac:repo ostemini$" or "user@host ~/repo$". Require shell-ish
	# punctuation in the first token so plain text like "Discount 50%" does not
	# look like a prompt.
	printf '%s\n' "$line" | grep -qE '^[~[:alnum:]_./:@()+-]*[:/@._~()+-][~[:alnum:]_./:@()+-]*[[:space:]][~[:alnum:]_./:@()+-]+([#$%]|>)$'
}
