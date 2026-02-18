# Screenshot Automation for Command Central

Automated pipeline to capture marketing screenshots of the Command Central VS Code extension.

## Approach

**macOS CLI orchestration** (Option B) — chosen over `vscode-extension-tester` for simplicity:

- `code` CLI to open projects and install the extension
- AppleScript to position/resize windows and navigate UI via command palette
- `screencapture -l<windowID>` for crisp Retina 2x window capture
- `sips` for cropping sidebar from full window

### Why not vscode-extension-tester?

- Requires Selenium/ChromeDriver setup, heavy dependencies
- Downloads its own VS Code instance (doesn't use your installed one)
- Overkill for 4 screenshots — better suited for automated UI testing
- The macOS approach captures the *real* VS Code with *real* rendering

## Prerequisites

- macOS (Apple Silicon supported)
- VS Code installed with `code` CLI in PATH
- The Command Central extension installed (or `vsce` to package it)
- Accessibility permissions for Terminal (System Settings → Privacy → Accessibility)

**Important:** The scripts use AppleScript to control VS Code via System Events. You must grant your terminal app Accessibility permissions, or the keyboard automation won't work.

## Quick Start

```bash
# Full pipeline: setup demo project + capture all screenshots
./capture.sh --setup --all

# Or step by step:
./setup-demo.sh                    # Create demo git repos
./capture.sh --hero                # Just the hero shot
./capture.sh --deleted             # Deleted files view
./capture.sh --multiroot           # Multi-root workspace
./capture.sh --gitstatus           # Staged/unstaged grouping
```

## Output

Screenshots are saved to `~/projects/vs-code-extension/site/screenshots/`:

| File | Description |
|------|-------------|
| `hero.png` | Main sidebar with time-grouped changes |
| `hero-sidebar.png` | Cropped to just the sidebar panel |
| `deleted-files.png` | Deleted file tracking view |
| `multi-root.png` | Multi-root workspace with 2 projects |
| `git-status.png` | Staged vs unstaged grouping |

All screenshots are Retina 2x resolution with VS Code's dark theme.

## Demo Project Structure

`setup-demo.sh` creates `/tmp/command-central-demo/` with:

- **my-app/** — Main project with:
  - Commits spanning 2 weeks, 4 days, yesterday, and today
  - 2 staged new files (Dashboard.tsx, useAuth.ts)
  - 2 staged deletions (deprecated-api.ts, legacy-helpers.ts)
  - 2 unstaged modifications (App.ts, index.ts)
  - 1 unstaged new file (api.ts)
- **api-server/** — Secondary project for multi-root demo
- **demo.code-workspace** — Multi-root workspace file

## Troubleshooting

### "Not permitted" / No keyboard input
Grant Accessibility access: System Settings → Privacy & Security → Accessibility → add your terminal app.

### Command Central sidebar doesn't appear
The script uses the command palette to show the sidebar. If that fails:
1. Check the extension is installed: `code --list-extensions | grep command-central`
2. Try manually: Cmd+Shift+P → "View: Show Command Central"

### Screenshots are blank or wrong window
The script uses `screencapture -l<windowID>` which captures a specific window. If VS Code has multiple windows, it picks `window 1` (front window).

### Cropping is wrong
The sidebar crop assumes ~350px (700px at 2x) for activity bar + sidebar. Adjust `crop_width` in `capture.sh` if your sidebar is wider/narrower.

## What Worked / What Didn't

### ✅ What works well
- `screencapture -l<windowID>` gives perfect Retina screenshots
- AppleScript + command palette is reliable for navigating VS Code
- Workspace settings in `demo.code-workspace` apply dark theme automatically
- `sips` cropping is fast and doesn't need ImageMagick

### ⚠️ Limitations
- Requires Accessibility permissions (one-time macOS setup)
- AppleScript keyboard automation is timing-dependent (adjust `*_WAIT` constants if needed)
- Can't programmatically expand specific tree nodes — relies on default expanded state
- If VS Code prompts (trust workspace, etc.), it may interfere — dismiss manually first run

### ❌ What was tried and abandoned
- **Browser Relay / OpenClaw browser control** — VS Code is an Electron app, not a web page; browser relay can't access it
- **vscode-extension-tester** — too heavy for screenshot capture; better for automated UI testing
