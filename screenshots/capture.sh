#!/usr/bin/env bash
# capture.sh — Automated screenshot capture for Command Central extension
# Uses macOS CLI + AppleScript + screencapture for reliable window capture
#
# Usage: ./capture.sh [--setup] [--all | --hero | --deleted | --multiroot | --gitstatus]
#   --setup    Run setup-demo.sh first
#   --all      Capture all 4 screenshots (default)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$EXTENSION_DIR/site/screenshots"
DEMO_BASE="/tmp/command-central-demo"
PROJ1="$DEMO_BASE/my-app"
WORKSPACE="$DEMO_BASE/demo.code-workspace"

# Timing constants
VSCODE_STARTUP_WAIT=5    # seconds to wait for VS Code to start
EXTENSION_LOAD_WAIT=4    # seconds to wait for extension to load
SIDEBAR_SWITCH_WAIT=2    # seconds to wait after switching sidebar

mkdir -p "$OUTPUT_DIR"

###############################################################################
# Helpers
###############################################################################

log() { echo "📸 $*"; }

ensure_demo() {
  if [[ ! -d "$PROJ1/.git" ]]; then
    log "Demo project not found. Running setup..."
    bash "$SCRIPT_DIR/setup-demo.sh"
  fi
}

# Build & install extension from source
install_extension() {
  log "Building and installing Command Central extension..."
  if [[ -f "$EXTENSION_DIR/dist/extension.js" ]]; then
    log "Extension already built, checking if installed..."
  else
    log "Building extension..."
    (cd "$EXTENSION_DIR" && bun run build 2>/dev/null) || true
  fi
  
  # Package and install
  if command -v vsce &>/dev/null; then
    (cd "$EXTENSION_DIR" && vsce package -o /tmp/command-central.vsix 2>/dev/null) || true
    code --install-extension /tmp/command-central.vsix --force 2>/dev/null || true
  else
    log "vsce not found — assuming extension is already installed"
    log "Install with: code --install-extension oste.command-central"
  fi
}

# Close VS Code gracefully
close_vscode() {
  osascript -e 'tell application "Visual Studio Code" to quit' 2>/dev/null || true
  sleep 2
}

# Open VS Code and wait for it to be ready
open_vscode() {
  local target="$1"
  log "Opening VS Code with: $target"
  code "$target" --new-window 2>/dev/null &
  sleep "$VSCODE_STARTUP_WAIT"
}

# Resize and position VS Code window for consistent screenshots
position_window() {
  local width="${1:-1280}"
  local height="${2:-900}"
  osascript << EOF
tell application "Visual Studio Code"
  activate
  delay 0.5
  set bounds of front window to {100, 100, $((100 + width)), $((100 + height))}
end tell
EOF
  sleep 1
}

# Focus Command Central sidebar via keyboard shortcut
focus_command_central() {
  log "Focusing Command Central sidebar..."
  # Open command palette and focus the Command Central view
  osascript << 'EOF'
tell application "Visual Studio Code"
  activate
  delay 0.5
end tell
-- Open command palette: Cmd+Shift+P
tell application "System Events"
  tell process "Code"
    keystroke "p" using {command down, shift down}
    delay 0.8
    -- Type to find Command Central focus command
    keystroke "Command Central: Focus"
    delay 0.5
    keystroke return
    delay 1
  end tell
end tell
EOF
  sleep "$SIDEBAR_SWITCH_WAIT"
}

# Alternative: click the Command Central activity bar icon
click_activity_bar() {
  log "Clicking Command Central in activity bar..."
  osascript << 'EOF'
tell application "Visual Studio Code"
  activate
  delay 0.5
end tell
-- Use command palette to focus the view
tell application "System Events"
  tell process "Code"
    keystroke "p" using {command down, shift down}
    delay 0.8
    keystroke "View: Show Command Central"
    delay 1
    keystroke return
    delay 1.5
  end tell
end tell
EOF
  sleep "$SIDEBAR_SWITCH_WAIT"
}

# Capture window screenshot at Retina 2x
capture_window() {
  local output_file="$1"
  local window_id
  
  # Get VS Code window ID
  window_id=$(osascript -e 'tell app "Visual Studio Code" to id of window 1' 2>/dev/null) || {
    log "ERROR: Could not get VS Code window ID. Is VS Code running?"
    return 1
  }
  
  log "Capturing window (ID: $window_id) → $output_file"
  screencapture -l"$window_id" -o -x "$output_file"
  
  if [[ -f "$output_file" ]]; then
    local size
    size=$(stat -f%z "$output_file")
    log "✅ Saved: $output_file ($(( size / 1024 ))KB)"
  else
    log "❌ Failed to capture: $output_file"
    return 1
  fi
}

# Run VS Code command via command palette
run_command() {
  local cmd="$1"
  osascript << EOF
tell application "System Events"
  tell process "Code"
    keystroke "p" using {command down, shift down}
    delay 0.8
    keystroke "$cmd"
    delay 0.5
    keystroke return
    delay 1
  end tell
end tell
EOF
  sleep 1
}

# Set a VS Code setting
set_vscode_setting() {
  local key="$1" value="$2"
  # Use command line to update settings
  local settings_file="$HOME/Library/Application Support/Code/User/settings.json"
  if command -v jq &>/dev/null && [[ -f "$settings_file" ]]; then
    local tmp
    tmp=$(mktemp)
    jq --arg k "$key" --argjson v "$value" '.[$k] = $v' "$settings_file" > "$tmp" && mv "$tmp" "$settings_file"
  fi
}

###############################################################################
# Screenshot Scenarios
###############################################################################

capture_hero() {
  log "=== Capturing HERO screenshot ==="
  close_vscode
  open_vscode "$PROJ1"
  position_window 1280 900
  sleep "$EXTENSION_LOAD_WAIT"
  click_activity_bar
  sleep 2
  capture_window "$OUTPUT_DIR/hero.png"
}

capture_deleted() {
  log "=== Capturing DELETED FILES screenshot ==="
  # The demo project already has deleted files (deprecated-api.ts, legacy-helpers.ts)
  # Just make sure we're showing the right view
  close_vscode
  open_vscode "$PROJ1"
  position_window 1280 900
  sleep "$EXTENSION_LOAD_WAIT"
  click_activity_bar
  sleep 2
  
  # Expand tree nodes to show deleted files
  # The deleted files should show with strikethrough/special icon in the sidebar
  capture_window "$OUTPUT_DIR/deleted-files.png"
}

capture_multiroot() {
  log "=== Capturing MULTI-ROOT screenshot ==="
  close_vscode
  open_vscode "$WORKSPACE"
  position_window 1280 900
  sleep "$EXTENSION_LOAD_WAIT"
  click_activity_bar
  sleep 3  # Multi-root needs more time to load both repos
  capture_window "$OUTPUT_DIR/multi-root.png"
}

capture_gitstatus() {
  log "=== Capturing GIT STATUS (staged/unstaged grouping) screenshot ==="
  close_vscode
  
  # Enable git status grouping
  set_vscode_setting "commandCentral.gitStatusGrouping.enabled" "true"
  
  open_vscode "$PROJ1"
  position_window 1280 900
  sleep "$EXTENSION_LOAD_WAIT"
  click_activity_bar
  sleep 2
  
  # Toggle git status grouping via command palette if needed
  run_command "Command Central: Toggle Git Status Grouping"
  sleep 2
  
  capture_window "$OUTPUT_DIR/git-status.png"
  
  # Reset setting
  set_vscode_setting "commandCentral.gitStatusGrouping.enabled" "false"
}

###############################################################################
# Crop sidebar from full window screenshot (optional post-processing)
###############################################################################

crop_sidebar() {
  local input="$1" output="$2"
  # Sidebar is typically the left ~350px of the window (at 2x = 700px)
  # Activity bar is ~50px, sidebar panel ~300px
  if command -v sips &>/dev/null; then
    # Use macOS sips to crop — get dimensions first
    local width height
    width=$(sips -g pixelWidth "$input" | tail -1 | awk '{print $2}')
    height=$(sips -g pixelHeight "$input" | tail -1 | awk '{print $2}')
    
    # Crop to left 700px (350pt at 2x retina) — activity bar + sidebar
    local crop_width=700
    if (( width > crop_width )); then
      cp "$input" "$output"
      sips --cropToHeightWidth "$height" "$crop_width" "$output" >/dev/null 2>&1
      log "Cropped sidebar: $output (${crop_width}x${height})"
    else
      cp "$input" "$output"
    fi
  else
    cp "$input" "$output"
  fi
}

###############################################################################
# Main
###############################################################################

DO_SETUP=false
TARGETS=()

for arg in "$@"; do
  case "$arg" in
    --setup)    DO_SETUP=true ;;
    --hero)     TARGETS+=(hero) ;;
    --deleted)  TARGETS+=(deleted) ;;
    --multiroot) TARGETS+=(multiroot) ;;
    --gitstatus) TARGETS+=(gitstatus) ;;
    --all)      TARGETS=(hero deleted multiroot gitstatus) ;;
    --help|-h)
      echo "Usage: $0 [--setup] [--all | --hero | --deleted | --multiroot | --gitstatus]"
      exit 0
      ;;
  esac
done

# Default to all
[[ ${#TARGETS[@]} -eq 0 ]] && TARGETS=(hero deleted multiroot gitstatus)

if $DO_SETUP; then
  bash "$SCRIPT_DIR/setup-demo.sh"
fi

ensure_demo
install_extension

log "Dark theme will be applied via workspace settings"
log "Capturing ${#TARGETS[@]} screenshots..."

for target in "${TARGETS[@]}"; do
  case "$target" in
    hero)      capture_hero ;;
    deleted)   capture_deleted ;;
    multiroot) capture_multiroot ;;
    gitstatus) capture_gitstatus ;;
  esac
done

# Optional: create cropped sidebar versions
log ""
log "Creating cropped sidebar versions..."
for f in "$OUTPUT_DIR"/*.png; do
  [[ "$f" == *"-sidebar.png" ]] && continue
  base="${f%.png}"
  crop_sidebar "$f" "${base}-sidebar.png"
done

close_vscode

log ""
log "🎉 Done! Screenshots saved to: $OUTPUT_DIR"
ls -la "$OUTPUT_DIR"/*.png 2>/dev/null || true
