# Local Extension Preview Workflow

Test icon, asset, or UI changes locally **without publishing** to the Marketplace.

## Quick Reference (for agents)

```bash
# 1. Package
cd ~/projects/command-central
npx @vscode/vsce package --no-dependencies

# 2. Install
code --install-extension command-central-*.vsix --force

# 3. Reload VS Code (via OpenClaw node — AppleScript)
# Use nodes.run on "Mike's Mac mini" with:
osascript \
  -e 'tell application "Visual Studio Code" to activate' \
  -e 'delay 0.5' \
  -e 'tell application "System Events" to tell process "Code" to keystroke "p" using {command down, shift down}' \
  -e 'delay 1' \
  -e 'tell application "System Events" to tell process "Code" to keystroke "Reload Window"' \
  -e 'delay 0.5' \
  -e 'tell application "System Events" to tell process "Code" to key code 36'

# 4. Cleanup
rm command-central-*.vsix
```

## Switching Back to Marketplace Version

```bash
# Uninstall the local version
code --uninstall-extension oste.command-central

# Reinstall from Marketplace
code --install-extension oste.command-central

# Reload VS Code (same AppleScript as above)
```

## Notes

- The `code` CLI doesn't support sending commands to a running window, so we use AppleScript via the OpenClaw node (which has accessibility permissions).
- Local installs override the Marketplace version at the same version number. VS Code doesn't distinguish between them.
- Always clean up `.vsix` files — they're gitignored but large (~5MB).
- **Activity bar icon** must be monochrome `currentColor` only (VS Code requirement). Should visually match `site/images/logo.svg`.
