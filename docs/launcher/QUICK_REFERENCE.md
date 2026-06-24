# Launcher Quick Reference

## Commands

| Command | Palette | Description |
|---------|---------|-------------|
| `commandCentral.launcher.create` | Create Dock Launcher | Create launcher for current workspace |
| `commandCentral.launcher.list` | List Dock Launchers | Show all launchers in QuickPick |
| `commandCentral.launcher.remove` | Remove Dock Launcher | Remove selected launcher |
| `commandCentral.launcher.removeAll` | Remove All Launchers | Remove all project launchers |

## Settings

```json
{
  "commandCentral.project.icon": "🚀",
  "commandCentral.project.name": "My Project",
  "commandCentral.ghostty.launcherPath": "/path/to/ghostty-launcher/launcher"
}
```

## Shell Script Interface

```bash
# Create launcher
ghostty /path/to/project

# List (text)
ghostty list

# List (JSON)
GHOSTTY_JSON_OUTPUT=1 ghostty list

# Remove
ghostty remove "Project Name"

# Get Ghostty path
ghostty --which-binary
```

## Sync Commands

```bash
# Sync launcher from development repo
just sync-launcher

# Check if sync needed (automatic before dist)
just _check-launcher-sync
```

## Architecture

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Service | `terminal-launcher-service.ts` | Strategy selection, subprocess |
| Strategies | `launcher/*.ts` | Bundled vs user-configured |
| Types | `types/launcher-config.ts` | Type definitions |
| Script | `resources/bin/ghostty-launcher` | macOS operations |

## Platform Support

| Platform | Support |
|----------|---------|
| macOS | ✅ Full |
| Linux | ❌ Commands hidden |
| Windows | ❌ Commands hidden |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error |
| 2 | Unknown command |

## Testing

```bash
# Run launcher tests
bun test launcher

# Run specific strategies test
bun test strategies
```

## Troubleshooting

### Permission denied
```bash
chmod +x resources/bin/ghostty-launcher
```

### Launcher not found
- Check `commandCentral.ghostty.launcherPath` setting
- Verify bundled script exists: `ls -la resources/bin/ghostty-launcher`

### Out of sync warning
```bash
just sync-launcher  # Then commit the changes
```

## Source Repository

Development happens in: `~/ghostty-dock-launcher-v1`

Bundled script is synced before releases.
