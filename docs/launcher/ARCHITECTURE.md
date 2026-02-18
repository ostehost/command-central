# Launcher Subsystem Architecture

## Overview

The launcher subsystem provides macOS dock integration for project terminals. It creates `.app` bundles that can be dragged to the Dock for instant project terminal access.

**Platform**: macOS only (graceful degradation on other platforms)

## Architecture Decision: Hybrid Approach

| Aspect | Implementation |
|--------|---------------|
| **TypeScript Layer** | Settings, validation, subprocess bridge, commands |
| **Shell Script** | Icon generation, .app bundles, Dock integration |
| **Distribution** | Shell script bundled with extension VSIX |

### Why Hybrid (Not Full TypeScript Port)?

~35% of the launcher code uses macOS-specific APIs with no Node.js equivalent:

```
sips          - Apple's scriptable image processing (emoji → icon)
iconutil      - Icon set compiler (PNG → .icns)
osascript     - AppleScript runtime (folder icons, Dock)
lsregister    - LaunchServices registration
.app bundles  - macOS application structure
Info.plist    - Property list format
```

A full TypeScript port would require native Swift/Objective-C bindings. The existing shell script is battle-tested and feature-complete.

## Component Structure

```
┌────────────────────────────────────────────────────────────────┐
│                    VS Code Extension                           │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  TypeScript Services (src/services/launcher/)            │ │
│  │  • ILauncherStrategy interface                           │ │
│  │  • BundledLauncherStrategy (packaged script)             │ │
│  │  • UserLauncherStrategy (user-configured path)           │ │
│  └──────────────────────────────────────────────────────────┘ │
│                              │                                 │
│                              ▼                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  TerminalLauncherService                                 │ │
│  │  • Strategy selection (bundled vs user)                  │ │
│  │  • Subprocess execution via Bun.spawn                    │ │
│  │  • Process lifecycle management                          │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  Shell Script (resources/bin/ghostty-launcher)                 │
│  • Launcher creation (macOS .app bundles)                      │
│  • Icon generation (emoji → icns via sips/iconutil)            │
│  • Projects folder management (/Applications/Projects)         │
│  • Dock integration                                            │
│  • All macOS-specific operations                               │
└────────────────────────────────────────────────────────────────┘
```

## Strategy Pattern

The launcher service uses the Strategy pattern for flexibility:

### BundledLauncherStrategy
- Uses `resources/bin/ghostty-launcher` bundled with extension
- Handles VSIX extraction permissions (auto-chmod +x)
- Default on macOS

### UserLauncherStrategy
- Uses user-configured path (`commandCentral.terminal.launcherPath`)
- Full permission validation
- Allows custom launcher versions

### System Strategy (Future)
- Would use system-installed `ghostty-launcher` command
- Not yet implemented

## File Locations

| File | Purpose |
|------|---------|
| `src/services/launcher/` | TypeScript strategy implementations |
| `src/services/terminal-launcher-service.ts` | Main service orchestrating launcher operations |
| `src/types/launcher-config.ts` | Type definitions |
| `resources/bin/ghostty-launcher` | Bundled shell script |
| `resources/bin/.launcher-version` | Version tracking for sync |

## Sync Process

The `ghostty-launcher` script is developed in a separate repository (`ghostty-dock-launcher-v1`) and synced to this extension before releases.

```bash
# Sync launcher from development repo
just sync-launcher

# Check if sync is needed (used by dist command)
just _check-launcher-sync
```

The sync process:
1. Compares `resources/bin/ghostty-launcher` with source repo
2. Copies if different
3. Updates `.launcher-version` file
4. `dist` command warns if out of sync

## Shell Script Interface

```bash
# Create launcher for project
ghostty /path/to/project

# List existing launchers (text format)
ghostty list

# List launchers (JSON format for parsing)
GHOSTTY_JSON_OUTPUT=1 ghostty list

# Remove launcher
ghostty remove "Project Name"

# Get Ghostty binary path
ghostty --which-binary
```

**Exit codes**: 0=success, 1=error, 2=unknown command

## Configuration

Settings in `package.json`:

| Setting | Type | Description |
|---------|------|-------------|
| `commandCentral.terminal.launcherPath` | string | Custom launcher path (overrides bundled) |
| `commandCentral.terminal.app` | string | Custom terminal application path |
| `commandCentral.project.icon` | string | Default project emoji icon |
| `commandCentral.project.name` | string | Override project display name |

## Security Considerations

1. **Path validation**: All paths validated before subprocess execution
2. **Executable permissions**: Bundled script auto-chmod on VSIX extraction
3. **Audit logging**: SecurityService logs all launcher invocations
4. **Input sanitization**: Shell script sanitizes project names for bundle IDs

## Platform Behavior

| Platform | Behavior |
|----------|----------|
| macOS | Full functionality |
| Linux | Commands hidden, silent activation |
| Windows | Commands hidden, silent activation |

Platform detection uses `process.platform !== 'darwin'` for early exit.

## Testing

- Unit tests: `test/services/launcher/strategies.test.ts`
- Integration: Via VS Code Extension Host with `--extensionDevelopmentPath`

## Related Documentation

- [Quick Reference](./QUICK_REFERENCE.md) - Command summary
- [ARCHITECTURE.md](../../ARCHITECTURE.md) - Overall extension architecture
- Source repo: `~/ghostty-dock-launcher-v1`
