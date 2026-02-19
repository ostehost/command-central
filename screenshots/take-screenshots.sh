#!/usr/bin/env bash
# take-screenshots.sh — Deterministic screenshot capture for Command Central
#
# Produces clean marketing screenshots by:
# 1. Creating a temporary VS Code profile (no Chat/Copilot/other extensions)
# 2. Setting precise window dimensions via AppleScript
# 3. Using screencapture -l (window ID) for isolated capture
# 4. Closing panels/sidebars that pollute the shot
#
# Prerequisites:
#   - macOS with screencapture
#   - VS Code installed at /usr/local/bin/code
#   - Command Central extension .vsix built or installed
#   - Demo workspace at /tmp/command-central-demo/
#
# Usage:
#   ./take-screenshots.sh              # All screenshots
#   ./take-screenshots.sh hero         # Just the hero shot
#   ./take-screenshots.sh multiroot    # Multi-root workspace shot
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/cc-screenshots}"
DEMO_DIR="/tmp/command-central-demo"
WORKSPACE_FILE="$DEMO_DIR/demo.code-workspace"
PROFILE="cc-screenshots"

# Window dimensions (logical pixels — screencapture handles Retina 2x automatically)
WIN_WIDTH=1200
WIN_HEIGHT=800
WIN_X=100
WIN_Y=100

mkdir -p "$OUTPUT_DIR"

log() { printf '📸 %s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

###############################################################################
# Preflight
###############################################################################

[[ -d "$DEMO_DIR" ]] || die "Demo workspace not found. Run: bash $SCRIPT_DIR/setup-demo.sh"
command -v code &>/dev/null || die "VS Code CLI not found"
command -v osascript &>/dev/null || die "Not macOS"

###############################################################################
# VS Code profile setup — clean profile with only Command Central
###############################################################################

setup_profile_settings() {
  local profile_dir="$HOME/Library/Application Support/Code/User/profiles"
  
  # We'll use VS Code's --profile flag which auto-creates profiles.
  # But we need to pass settings that disable distracting UI.
  # Use a temp settings file via CLI args.
  :
}

# Build a clean user settings JSON for screenshot profile
SCREENSHOT_SETTINGS=$(cat <<'JSON'
{
  "workbench.colorTheme": "Default Dark+",
  "workbench.activityBar.location": "side",
  "workbench.sideBar.location": "left",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.welcomePage.enabled": false,
  "editor.minimap.enabled": false,
  "editor.renderWhitespace": "none",
  "editor.bracketPairColorization.enabled": true,
  "window.commandCenter": false,
  "window.menuBarVisibility": "compact",
  "window.titleBarStyle": "custom",
  "breadcrumbs.enabled": false,
  "chat.editor.enabled": false,
  "chat.commandCenter.enabled": false,
  "github.copilot.chat.enabled": false,
  "github.copilot.editor.enableAutoCompletions": false,
  "terminal.integrated.defaultProfile.osx": "zsh",
  "workbench.editor.showTabs": "single",
  "workbench.panel.defaultLocation": "bottom",
  "explorer.openEditors.visible": 0,
  "workbench.statusBar.visible": true,
  "commandCentral.project.icon": "",
  "files.exclude": {
    "**/.git": true,
    "**/.DS_Store": true
  }
}
JSON
)

###############################################################################
# Core functions
###############################################################################

kill_vscode() {
  log "Closing VS Code..."
  osascript -e 'tell application "Visual Studio Code" to quit' 2>/dev/null || true
  # Wait for full quit
  for _ in $(seq 1 10); do
    pgrep -q "Electron.*Code" 2>/dev/null || break
    sleep 0.5
  done
  sleep 1
}

start_vscode() {
  local target="$1"
  log "Opening VS Code: $target (profile: $PROFILE)"
  code --profile "$PROFILE" "$target" --new-window 2>/dev/null &
  
  # Wait for window to appear
  log "Waiting for VS Code window..."
  for _ in $(seq 1 30); do
    if osascript -e 'tell application "System Events" to get name of first process whose name is "Code"' &>/dev/null; then
      break
    fi
    sleep 0.5
  done
  sleep 4  # Let extension load
}

position_window() {
  local x="${1:-$WIN_X}" y="${2:-$WIN_Y}" w="${3:-$WIN_WIDTH}" h="${4:-$WIN_HEIGHT}"
  osascript <<EOF
tell application "Visual Studio Code" to activate
delay 0.3
tell application "System Events"
  tell process "Code"
    set position of window 1 to {${x}, ${y}}
    set size of window 1 to {${w}, ${h}}
  end tell
end tell
EOF
  sleep 0.5
}

# Close all panels (bottom panel, secondary sidebar, chat) 
close_panels() {
  log "Closing panels..."
  osascript <<'EOF'
tell application "Visual Studio Code" to activate
delay 0.3
tell application "System Events"
  tell process "Code"
    -- Close bottom panel (Cmd+J)
    keystroke "j" using {command down}
    delay 0.3
    -- Close secondary/right sidebar (Cmd+Option+B)
    keystroke "b" using {command down, option down}
    delay 0.3
  end tell
end tell
EOF
  sleep 0.5
}

# Focus Command Central in the primary sidebar
focus_cc_sidebar() {
  log "Focusing Command Central sidebar..."
  osascript <<'EOF'
tell application "Visual Studio Code" to activate
delay 0.3
tell application "System Events"
  tell process "Code"
    -- Open command palette
    keystroke "p" using {command down, shift down}
    delay 0.8
    -- Type to find our view
    keystroke "View: Show Command Central"
    delay 1.0
    keystroke return
    delay 1.5
  end tell
end tell
EOF
  sleep 2
}

# Get VS Code window ID for screencapture -l
get_window_id() {
  osascript <<'EOF'
tell application "System Events"
  tell process "Code"
    set frontWindow to first window
    -- Get the window's subrole to find it, then use CGWindowListCopyWindowInfo
  end tell
end tell
EOF
  # AppleScript can't directly give CGWindowID. Use CGWindowListCopyWindowInfo via Python.
  python3 -c "
import Quartz
windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
    Quartz.kCGNullWindowID
)
for w in windows:
    owner = w.get('kCGWindowOwnerName', '')
    name = w.get('kCGWindowName', '')
    if 'Code' in owner and name and 'Command Central' not in name:
        # Skip small utility windows
        bounds = w.get('kCGWindowBounds', {})
        if bounds.get('Width', 0) > 500:
            print(w['kCGWindowNumber'])
            break
" 2>/dev/null
}

capture() {
  local name="$1"
  local output="$OUTPUT_DIR/${name}.png"
  
  local wid
  wid=$(get_window_id)
  if [[ -z "$wid" ]]; then
    die "Could not find VS Code window ID"
  fi
  
  log "Capturing window $wid → $output"
  screencapture -l"$wid" -o -x "$output"
  
  if [[ -f "$output" ]]; then
    local dims
    dims=$(sips -g pixelWidth -g pixelHeight "$output" 2>/dev/null | grep pixel | awk '{print $2}' | tr '\n' 'x' | sed 's/x$//')
    log "✅ ${name}.png — ${dims}"
  else
    die "Capture failed: $output"
  fi
}

###############################################################################
# Screenshot scenarios
###############################################################################

shot_hero() {
  log "=== HERO: Multi-root with emoji icons ==="
  kill_vscode
  start_vscode "$WORKSPACE_FILE"
  position_window
  close_panels
  focus_cc_sidebar
  sleep 1
  # Give tree view time to populate
  sleep 2
  capture "hero"
}

shot_single() {
  log "=== SINGLE: One project focused ==="
  kill_vscode
  start_vscode "$DEMO_DIR/my-app"
  position_window
  close_panels
  focus_cc_sidebar
  sleep 2
  capture "single-project"
}

shot_gitstatus() {
  log "=== GIT STATUS: Staged/unstaged grouping ==="
  # Reuse current window if open, otherwise open workspace
  kill_vscode
  start_vscode "$WORKSPACE_FILE"
  position_window
  close_panels
  focus_cc_sidebar
  sleep 2
  
  # Toggle git status grouping via command palette
  log "Toggling git status grouping..."
  osascript <<'EOF'
tell application "System Events"
  tell process "Code"
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

TARGETS=("${@:-hero}")
[[ "$1" == "all" ]] 2>/dev/null && TARGETS=(hero single gitstatus)

log "Output: $OUTPUT_DIR"
log "Targets: ${TARGETS[*]}"
log ""

for t in "${TARGETS[@]}"; do
  case "$t" in
    hero)       shot_hero ;;
    single)     shot_single ;;
    gitstatus)  shot_gitstatus ;;
    multiroot)  shot_hero ;;  # alias
    *)          die "Unknown target: $t" ;;
  esac
done

kill_vscode
log ""
log "🎉 All done! Screenshots in: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR"/*.png 2>/dev/null
