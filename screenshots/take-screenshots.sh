#!/usr/bin/env bash
# take-screenshots.sh — Deterministic screenshot capture for Command Central
#
# STABLE WORKFLOW (documented 2026-02-18):
#   1. Uses a dedicated VS Code profile "cc-screenshots" with only Command Central
#   2. Profile settings disable minimap, breadcrumbs, and other visual noise
#   3. Uses `open -a` to launch VS Code (background `code &` doesn't work via node runner)
#   4. System Events process name for VS Code is "Electron" (not "Code")
#   5. CGWindowListCopyWindowInfo owner name IS "Code" (different from System Events!)
#   6. Use Swift + CoreGraphics to get CGWindowID, then `screencapture -l<id>`
#   7. Cmd+Option+B closes Chat/secondary sidebar, Cmd+J closes bottom panel
#
# SETUP (one-time per machine):
#   1. Install the extension in the profile:
#      code --profile cc-screenshots --install-extension /tmp/command-central-latest.vsix --force
#   2. Uninstall copilot from the profile:
#      code --profile cc-screenshots --uninstall-extension github.copilot-chat
#   3. Write clean settings to the profile's settings.json (see setup_profile below)
#   4. Run setup-demo.sh to create /tmp/command-central-demo/
#
# Usage:
#   ./take-screenshots.sh [hero|single|gitstatus|all]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${OUTPUT_DIR:-$SCRIPT_DIR}"
DEMO_DIR="/tmp/command-central-demo"
WORKSPACE_FILE="$DEMO_DIR/demo.code-workspace"
PROFILE="cc-screenshots"

# Window dimensions (logical pixels — Retina 2x captured automatically)
WIN_W=1200
WIN_H=800

log() { printf '📸 %s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

###############################################################################
# Preflight
###############################################################################

[[ -d "$DEMO_DIR" ]] || die "Demo not found. Run: bash $SCRIPT_DIR/setup-demo.sh"
command -v osascript &>/dev/null || die "Not macOS"

###############################################################################
# Profile settings (idempotent)
###############################################################################

setup_profile() {
  local profile_dir
  profile_dir=$(find "$HOME/Library/Application Support/Code/User/profiles" \
    -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1)
  
  [[ -z "$profile_dir" ]] && {
    log "No profile dir found. Open VS Code with --profile cc-screenshots first."
    return 1
  }
  
  cat > "$profile_dir/settings.json" << 'JSON'
{
  "workbench.colorTheme": "Default Dark+",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "editor.minimap.enabled": false,
  "editor.renderWhitespace": "none",
  "breadcrumbs.enabled": false,
  "editor.stickyScroll.enabled": false,
  "scm.diffDecorations": "none",
  "window.commandCenter": true,
  "workbench.editor.showTabs": "single"
}
JSON
  log "Profile settings written to $profile_dir/settings.json"
}

###############################################################################
# VS Code window management via System Events (process name = "Electron")
###############################################################################

kill_vscode() {
  osascript -e 'tell application "Visual Studio Code" to quit' 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -q "Electron" 2>/dev/null || break
    sleep 0.5
  done
  sleep 1
}

open_vscode() {
  local target="$1"
  log "Opening: $target"
  open -a "Visual Studio Code" "$target"
  
  # Wait for Electron process
  for _ in $(seq 1 30); do
    osascript -e 'tell application "System Events" to get name of first process whose name is "Electron"' &>/dev/null && break
    sleep 0.5
  done
  sleep 4  # Let extension load
}

position_window() {
  osascript -e "
tell application \"System Events\"
  tell process \"Electron\"
    set frontmost to true
    set position of window 1 to {100, 100}
    set size of window 1 to {${WIN_W}, ${WIN_H}}
  end tell
end tell"
  sleep 0.5
}

# Close distracting panels
close_panels() {
  osascript -e '
tell application "System Events"
  tell process "Electron"
    set frontmost to true
    delay 0.3
    -- Close bottom panel (Cmd+J)
    keystroke "j" using {command down}
    delay 0.3
    -- Close Chat/secondary sidebar (Cmd+Option+B)
    keystroke "b" using {command down, option down}
    delay 0.3
    -- Close Welcome tab (Cmd+W)
    keystroke "w" using {command down}
    delay 0.5
  end tell
end tell'
}

# Focus Command Central sidebar
focus_cc() {
  osascript -e '
tell application "System Events"
  tell process "Electron"
    set frontmost to true
    delay 0.3
    keystroke "p" using {command down, shift down}
    delay 1.0
    keystroke "View: Show Command Central"
    delay 1.5
    keystroke return
    delay 2.0
  end tell
end tell'
  sleep 1
}

# Open a file in the editor
open_file() {
  local filename="$1"
  osascript -e "
tell application \"System Events\"
  tell process \"Electron\"
    set frontmost to true
    delay 0.3
    keystroke \"p\" using {command down}
    delay 0.8
    keystroke \"${filename}\"
    delay 0.5
    keystroke return
    delay 1.0
  end tell
end tell"
}

# Run VS Code command via palette
run_command() {
  local cmd="$1"
  osascript -e "
tell application \"System Events\"
  tell process \"Electron\"
    set frontmost to true
    delay 0.3
    keystroke \"p\" using {command down, shift down}
    delay 0.8
    keystroke \"${cmd}\"
    delay 0.8
    keystroke return
    delay 1.5
  end tell
end tell"
}

###############################################################################
# Window ID via Swift + CoreGraphics (CGWindowID ≠ AppleScript window id)
# Owner name in CGWindowList is "Code", NOT "Electron"
###############################################################################

get_window_id() {
  swift -e '
import CoreGraphics
let windowList = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as! [[String: Any]]
for w in windowList {
    let owner = w["kCGWindowOwnerName"] as? String ?? ""
    let bounds = w["kCGWindowBounds"] as? [String: Any] ?? [:]
    let width = bounds["Width"] as? Int ?? 0
    if owner == "Code" && width > 500 {
        print(w["kCGWindowNumber"] as! Int)
        break
    }
}
' 2>/dev/null
}

###############################################################################
# Capture
###############################################################################

capture() {
  local name="$1"
  local output="$OUTPUT_DIR/${name}.png"
  
  local wid
  wid=$(get_window_id)
  [[ -z "$wid" ]] && die "Could not get VS Code window ID"
  
  log "Capturing window $wid → $output"
  screencapture -l"$wid" -o -x "$output"
  
  local dims
  dims=$(sips -g pixelWidth -g pixelHeight "$output" 2>/dev/null | grep pixel | awk '{print $2}' | tr '\n' 'x' | sed 's/x$//')
  log "✅ ${name}.png — ${dims}"
}

###############################################################################
# Scenarios
###############################################################################

shot_hero() {
  log "=== HERO: Multi-root workspace with emoji icons ==="
  kill_vscode
  open_vscode "$WORKSPACE_FILE"
  position_window
  close_panels
  focus_cc
  open_file "App.ts"
  # Close panels again (opening file can trigger Chat)
  sleep 1
  osascript -e '
tell application "System Events"
  tell process "Electron"
    keystroke "b" using {command down, option down}
    delay 0.2
    keystroke "j" using {command down}
  end tell
end tell'
  sleep 1
  capture "hero"
}

shot_gitstatus() {
  log "=== GIT STATUS: Staged/unstaged grouping ==="
  kill_vscode
  open_vscode "$WORKSPACE_FILE"
  position_window
  close_panels
  focus_cc
  run_command "Command Central: Toggle Git Status Grouping"
  sleep 2
  osascript -e '
tell application "System Events"
  tell process "Electron"
    keystroke "b" using {command down, option down}
    delay 0.2
    keystroke "j" using {command down}
  end tell
end tell'
  sleep 1
  capture "git-status"
}

###############################################################################
# Main
###############################################################################

setup_profile

TARGETS=("${@:-hero}")
[[ "${1:-}" == "all" ]] && TARGETS=(hero gitstatus)

log "Output: $OUTPUT_DIR"
for t in "${TARGETS[@]}"; do
  case "$t" in
    hero)       shot_hero ;;
    gitstatus)  shot_gitstatus ;;
    all)        shot_hero; shot_gitstatus ;;
    *)          die "Unknown: $t" ;;
  esac
done

kill_vscode
log "🎉 Done! Screenshots in $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR"/*.png 2>/dev/null || true
