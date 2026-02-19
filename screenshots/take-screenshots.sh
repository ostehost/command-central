#!/usr/bin/env bash
# take-screenshots.sh — Deterministic screenshot capture for Command Central
#
# Stable workflow for capturing marketing screenshots of the VS Code extension.
# Designed to be reusable across feature releases.
#
# KEY DISCOVERIES (documented so future runs don't re-learn these):
#   1. VS Code's System Events process name is "Electron", NOT "Code"
#   2. CGWindowListCopyWindowInfo uses owner name "Code" (different from #1)
#   3. `screencapture -l<windowID>` is the only reliable capture method
#   4. Use a dedicated VS Code profile to avoid Copilot/Chat pollution
#   5. sips --cropToHeightWidth crops from CENTER (useless for sidebar crops)
#   6. Use Python Pillow for precise image cropping
#   7. Window dimensions at 2x Retina: 1200x800 logical = 2400x1600px capture
#
# Prerequisites:
#   - macOS with screencapture + Accessibility permissions
#   - VS Code installed at /usr/local/bin/code
#   - Python3 with Pillow (`pip3 install Pillow`)
#   - Demo workspace at /tmp/command-central-demo/ (run setup-demo.sh first)
#   - Command Central .vsix built and installed in screenshot profile
#
# Setup (one-time):
#   cd <repo> && npx vsce package -o /tmp/cc.vsix
#   code --profile cc-screenshots --install-extension /tmp/cc.vsix --force
#   code --profile cc-screenshots --uninstall-extension github.copilot-chat
#
# Usage:
#   ./take-screenshots.sh              # All screenshots
#   ./take-screenshots.sh hero         # Just the hero shot
#   ./take-screenshots.sh sidebar      # Just the sidebar crop
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/cc-screenshots}"
DEMO_DIR="/tmp/command-central-demo"
WORKSPACE_FILE="$DEMO_DIR/demo.code-workspace"
PROFILE="cc-screenshots"

# VS Code process names (different in different APIs!)
SYSTEM_EVENTS_PROCESS="Electron"     # What macOS System Events sees
CGWINDOW_OWNER="Code"               # What CGWindowListCopyWindowInfo sees

# Window dimensions (logical pixels — Retina doubles these)
WIN_WIDTH=1200
WIN_HEIGHT=800
WIN_X=100
WIN_Y=100

# Sidebar crop width at 2x Retina (activity bar ~100px + sidebar ~670px)
SIDEBAR_CROP_WIDTH=770

mkdir -p "$OUTPUT_DIR"

log() { printf '📸 %s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

###############################################################################
# Preflight
###############################################################################

[[ -d "$DEMO_DIR" ]] || die "Demo workspace not found. Run: bash $SCRIPT_DIR/setup-demo.sh"
command -v code &>/dev/null || die "VS Code CLI not found"
command -v osascript &>/dev/null || die "Not macOS"
python3 -c "from PIL import Image" 2>/dev/null || die "Python Pillow not installed. Run: pip3 install Pillow"

###############################################################################
# Profile settings (clean, distraction-free)
###############################################################################

apply_profile_settings() {
  local settings_dir
  settings_dir=$(find "$HOME/Library/Application Support/Code/User/profiles" -name settings.json -exec dirname {} \; 2>/dev/null | head -1)
  
  if [[ -z "$settings_dir" ]]; then
    log "WARNING: Could not find profile settings directory"
    return
  fi
  
  cat > "$settings_dir/settings.json" << 'JSON'
{
  "workbench.colorTheme": "Default Dark+",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "editor.minimap.enabled": false,
  "editor.renderWhitespace": "none",
  "breadcrumbs.enabled": false,
  "editor.scrollbar.vertical": "hidden",
  "editor.glyphMargin": false,
  "editor.lineNumbers": "on",
  "editor.stickyScroll.enabled": false,
  "window.commandCenter": true,
  "scm.diffDecorations": "none",
  "workbench.editor.showTabs": "single"
}
JSON
  log "Profile settings applied"
}

###############################################################################
# Core functions
###############################################################################

kill_vscode() {
  osascript -e "tell application \"Visual Studio Code\" to quit" 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -q "Electron.*Code" 2>/dev/null || break
    sleep 0.5
  done
  sleep 1
}

start_vscode() {
  local target="$1"
  log "Opening VS Code: $target"
  open -a "Visual Studio Code" "$target"
  
  # Wait for window
  for _ in $(seq 1 30); do
    if osascript -e "tell application \"System Events\" to get name of first process whose name is \"$SYSTEM_EVENTS_PROCESS\"" &>/dev/null; then
      break
    fi
    sleep 0.5
  done
  sleep 5  # Let extension fully load
}

position_window() {
  osascript << EOF
tell application "System Events"
  tell process "$SYSTEM_EVENTS_PROCESS"
    set frontmost to true
    delay 0.3
    set position of window 1 to {${WIN_X}, ${WIN_Y}}
    set size of window 1 to {${WIN_WIDTH}, ${WIN_HEIGHT}}
  end tell
end tell
EOF
  sleep 0.5
}

close_panels() {
  log "Closing panels..."
  osascript << EOF
tell application "System Events"
  tell process "$SYSTEM_EVENTS_PROCESS"
    set frontmost to true
    delay 0.3
    -- Close bottom panel (Cmd+J)
    keystroke "j" using {command down}
    delay 0.3
    -- Close secondary sidebar (Cmd+Option+B)
    keystroke "b" using {command down, option down}
    delay 0.3
    -- Close Welcome tab (Cmd+W)
    keystroke "w" using {command down}
    delay 0.5
  end tell
end tell
EOF
  sleep 0.5
}

focus_command_central() {
  log "Focusing Command Central sidebar..."
  osascript << EOF
tell application "System Events"
  tell process "$SYSTEM_EVENTS_PROCESS"
    set frontmost to true
    delay 0.3
    keystroke "p" using {command down, shift down}
    delay 1.0
    keystroke "View: Show Command Central"
    delay 1.5
    keystroke return
    delay 2.0
  end tell
end tell
EOF
  sleep 2
}

open_file() {
  local filename="$1"
  log "Opening file: $filename"
  osascript << EOF
tell application "System Events"
  tell process "$SYSTEM_EVENTS_PROCESS"
    set frontmost to true
    delay 0.3
    keystroke "p" using {command down}
    delay 0.8
    keystroke "$filename"
    delay 0.8
    keystroke return
    delay 1.0
  end tell
end tell
EOF
  sleep 1
}

# Get VS Code main window ID using Swift + CoreGraphics
get_window_id() {
  swift -e "
import CoreGraphics
let windowList = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as! [[String: Any]]
for w in windowList {
    let owner = w[\"kCGWindowOwnerName\"] as? String ?? \"\"
    let bounds = w[\"kCGWindowBounds\"] as? [String: Any] ?? [:]
    let width = bounds[\"Width\"] as? Int ?? 0
    if owner == \"$CGWINDOW_OWNER\" && width > 500 {
        print(w[\"kCGWindowNumber\"] as! Int)
        break
    }
}
" 2>/dev/null
}

capture() {
  local name="$1"
  local output="$OUTPUT_DIR/${name}.png"
  
  local wid
  wid=$(get_window_id)
  [[ -n "$wid" ]] || die "Could not find VS Code window ID"
  
  log "Capturing window $wid → $output"
  screencapture -l"$wid" -o -x "$output"
  
  local dims
  dims=$(sips -g pixelWidth -g pixelHeight "$output" 2>/dev/null | grep pixel | awk '{print $2}' | tr '\n' 'x' | sed 's/x$//')
  log "✅ ${name}.png — ${dims}"
}

# Crop sidebar from full window screenshot using Pillow
crop_sidebar() {
  local input="$1" output="$2"
  python3 -c "
from PIL import Image
im = Image.open('$input')
sidebar = im.crop((0, 0, $SIDEBAR_CROP_WIDTH, im.height))
sidebar.save('$output')
print(f'Cropped: {sidebar.size}')
"
}

###############################################################################
# Screenshot scenarios
###############################################################################

shot_hero() {
  log "=== HERO: Multi-root workspace with emoji icons ==="
  kill_vscode
  apply_profile_settings
  start_vscode "$WORKSPACE_FILE"
  position_window
  close_panels
  focus_command_central
  open_file "App.ts"
  sleep 1
  close_panels  # Close any panel that reopened
  capture "hero"
}

shot_sidebar() {
  log "=== SIDEBAR: Cropped sidebar only ==="
  if [[ ! -f "$OUTPUT_DIR/hero.png" ]]; then
    shot_hero
  fi
  crop_sidebar "$OUTPUT_DIR/hero.png" "$OUTPUT_DIR/sidebar.png"
}

shot_gitstatus() {
  log "=== GIT STATUS: Staged/unstaged grouping ==="
  kill_vscode
  apply_profile_settings
  start_vscode "$WORKSPACE_FILE"
  position_window
  close_panels
  focus_command_central
  sleep 1
  
  # Toggle git status grouping
  osascript << EOF
tell application "System Events"
  tell process "$SYSTEM_EVENTS_PROCESS"
    keystroke "p" using {command down, shift down}
    delay 0.8
    keystroke "Command Central: Toggle Git Status Grouping"
    delay 0.8
    keystroke return
    delay 2
  end tell
end tell
EOF
  sleep 2
  capture "git-status"
}

###############################################################################
# Main
###############################################################################

TARGETS=("${@:-hero sidebar}")
[[ "${1:-}" == "all" ]] && TARGETS=(hero sidebar gitstatus)

log "Output: $OUTPUT_DIR"
log "Targets: ${TARGETS[*]}"
log ""

for t in "${TARGETS[@]}"; do
  case "$t" in
    hero)       shot_hero ;;
    sidebar)    shot_sidebar ;;
    gitstatus)  shot_gitstatus ;;
    *)          die "Unknown target: $t" ;;
  esac
done

kill_vscode
log ""
log "🎉 Done! Screenshots in: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR"/*.png 2>/dev/null
