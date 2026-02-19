# Screenshot Workflow

## Quick Reference

```bash
# One-time setup
bash setup-demo.sh                    # Create demo workspace at /tmp/command-central-demo/
cd ~/projects/command-central
npx vsce package -o /tmp/cc.vsix      # Build VSIX
code --profile cc-screenshots --install-extension /tmp/cc.vsix --force
code --profile cc-screenshots --uninstall-extension github.copilot-chat

# Capture
bash take-screenshots.sh hero         # Just hero shot
bash take-screenshots.sh all          # All shots
```

## Architecture

**Profile-based isolation**: Uses a dedicated VS Code profile `cc-screenshots` with only Command Central installed. This avoids Chat/Copilot panels, extension noise, and settings pollution.

**Window capture**: Uses `screencapture -l<windowID>` for isolated window capture (no other desktop elements). Window ID obtained via Swift + CoreGraphics.

## Critical Gotchas (learned the hard way)

| What | Reality | Why it matters |
|------|---------|----------------|
| System Events process name | `Electron` | AppleScript targeting uses this |
| CGWindowList owner name | `Code` | Swift window ID lookup uses this |
| `code --profile foo &` via node runner | Doesn't work | Use `open -a "Visual Studio Code"` instead |
| Chat panel | Opens automatically | Must close with Cmd+Option+B after every file open |
| `package.json` `files` field | Conflicts with `.vscodeignore` | Use one or the other, not both |
| Welcome tab | Appears on reload | Close with Cmd+W after each reload |
| Profile settings path | `~/Library/Application Support/Code/User/profiles/<hash>/settings.json` | Find with: `find ... -name settings.json` |

## Profile Settings

Written automatically by `take-screenshots.sh`. Key settings:
- `editor.minimap.enabled: false`
- `breadcrumbs.enabled: false`
- `workbench.startupEditor: "none"`
- `scm.diffDecorations: "none"`
- `editor.stickyScroll.enabled: false`

## Demo Workspace

`/tmp/command-central-demo/` contains 3 git repos:
- `my-app` — icon: 🚀, 6 changed files
- `api-server` — icon: ⚡, 5 changed files  
- `shared-lib` — icon: 📦, 1 changed file

Each has `.vscode/settings.json` with `commandCentral.project.icon` and `commandCentral.project.name`.

## Output

Screenshots saved to `screenshots/` at 2x Retina (2400x1600 from 1200x800 window).
