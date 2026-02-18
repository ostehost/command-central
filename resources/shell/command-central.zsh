# Command Central Shell Integration
# Source this in your .zshrc: source "<path>/command-central.zsh"

# Only activate if inside a Command Central terminal
[[ -z "$COMMAND_CENTRAL_PROJECT" ]] && return

# Report CWD changes to VS Code (for future use)
__cc_precmd() {
  # Could write to a pipe/file that the extension reads
  :
}

# Notify on long-running command completion
__cc_preexec() {
  __cc_cmd_start=$EPOCHSECONDS
  __cc_cmd="$1"
}

__cc_precmd_notify() {
  local duration=$(( EPOCHSECONDS - ${__cc_cmd_start:-$EPOCHSECONDS} ))
  if (( duration > 10 )); then
    terminal-notifier \
      -title "$COMMAND_CENTRAL_PROJECT" \
      -message "✅ ${__cc_cmd} completed (${duration}s)" \
      -group "$COMMAND_CENTRAL_PROJECT" \
      -activate com.commandcentral.${COMMAND_CENTRAL_PROJECT// /-} \
      2>/dev/null
  fi
}

precmd_functions+=(__cc_precmd __cc_precmd_notify)
preexec_functions+=(__cc_preexec)
