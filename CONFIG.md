# Command Central Configuration Guide

This guide provides comprehensive documentation for all Command Central extension settings and configuration options.

## Quick Setup

### Setting a Custom Terminal Application

To use a custom terminal application (like iTerm2, WezTerm, or Kitty) instead of the default:

1. Open VS Code Settings (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux)
2. Search for `commandCentral.terminal.app`
3. Enter the full path to your terminal application:
   - **iTerm2**: `/Applications/iTerm.app`
   - **WezTerm**: `/Applications/WezTerm.app`
   - **Kitty**: `/Applications/Kitty.app`
   - **Alacritty**: `/Applications/Alacritty.app`

The launcher will pass this path as the `TERMINAL_APP` environment variable to the launcher script.

### Enabling Git Sort

1. Open Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux)
2. Run `Command Central: Enable Git Sort`
3. Your git changes will now be sorted by modification time in the Source Control panel

## Configuration Levels & Scopes

Command Central uses different configuration scopes for optimal organization:

### Configuration Scopes Explained

| Scope | Storage Location | Description |
|-------|-----------------|-------------|
| `machine` | User settings (local only) | Machine-specific paths that shouldn't sync |
| `machine-overridable` | User settings | Can be overridden in workspace settings |
| `resource` | Workspace settings | Project/folder-specific settings |
| `window` | User or workspace | Per-window preferences |

### Where Settings Are Stored

**User Settings** (Global - `~/Library/Application Support/Code/User/settings.json`):
- `commandCentral.terminal.launcherPath` (scope: machine)
- `commandCentral.terminal.app` (scope: machine-overridable)
- `commandCentral.terminal.autoConfigureProject`
- `commandCentral.terminal.logLevel`
- `commandCentral.terminal.executionTimeout`
- `commandCentral.terminal.maxBuffer`
- `commandCentral.gitSort.enabled` (scope: window)
- `commandCentral.gitSort.logLevel` (scope: window)
- `commandCentral.statusBar.*` (scope: window)

**Workspace Settings** (Project-specific - `.vscode/settings.json`):
- `commandCentral.project.icon` (scope: resource)
- `commandCentral.project.name` (scope: resource)
- `commandCentral.terminal.theme` (can be workspace-specific)

## Complete Configuration Reference

### Terminal Settings (`commandCentral.terminal.*`)

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `launcherPath` | string | `~/ghostty-dock-launcher-v1/ghostty` | machine | Path to the terminal launcher executable |
| `app` | string | - | machine-overridable | Path to custom terminal application (e.g., `/Applications/iTerm.app`) |
| `autoConfigureProject` | boolean | `true` | application | Prompt to configure project settings when opening new workspaces |
| `logLevel` | enum | `"info"` | application | Logging level: `"debug"`, `"info"`, `"warn"`, `"error"` |
| `executionTimeout` | number | `30000` | application | Maximum execution time in milliseconds (1-300 seconds) |
| `maxBuffer` | number | `10485760` | application | Maximum buffer size in bytes for terminal output (1KB - 50MB) |
| `theme` | string | `"GitHub Dark"` | resource | Terminal theme to use |

### Git Sort Settings (`commandCentral.gitSort.*`)

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `enabled` | boolean | `false` | window | Enable sorting of git changes by modification time |
| `logLevel` | enum | `"info"` | window | Logging level: `"debug"`, `"info"`, `"warn"`, `"error"` |

### Project Settings (`commandCentral.project.*`)

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `icon` | string | - | resource | Icon/emoji to display in status bar for this workspace |
| `name` | string | - | resource | Display name for this workspace project |

### Status Bar Settings (`commandCentral.statusBar.*`)

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `showProjectIcon` | boolean | `true` | window | Show project icon in status bar |
| `priority` | number | `10000` | window | Priority for status bar positioning (higher = further left) |

### Workspace-level Settings

These settings are stored in your workspace's `.vscode/settings.json`:

| Setting | Type | Description |
|---------|------|-------------|
| `projectIcon` | string | Emoji or icon for the project (legacy format, still supported) |
| `projectName` | string | Display name for the project (legacy format, still supported) |
| `ghosttyTheme` | string | Terminal theme specific to this project |

## Examples

### Example: User Settings Configuration

Add to your user settings.json:

```json
{
  "commandCentral.terminal.app": "/Applications/iTerm.app",
  "commandCentral.terminal.logLevel": "debug",
  "commandCentral.terminal.autoConfigureProject": false,
  "commandCentral.project.icon": "🚀",
  "commandCentral.project.name": "My Project",
  "commandCentral.gitSort.enabled": true,
  "commandCentral.statusBar.showProjectIcon": true
}
```

### Example: Workspace Settings Configuration

Add to your workspace's `.vscode/settings.json`:

```json
{
  "commandCentral.project.icon": "🚀",
  "commandCentral.project.name": "My Awesome Project",
  "ghosttyTheme": "GitHub Dark"
}
```

**Note**: The legacy format (`projectIcon`, `projectName`) is still supported for backward compatibility.

### Example: Custom Terminal with Specific Theme

User settings:
```json
{
  "commandCentral.terminal.app": "/Applications/WezTerm.app",
  "commandCentral.terminal.theme": "Dracula"
}
```

Workspace settings:
```json
{
  "commandCentral.project.icon": "🎨",
  "commandCentral.project.name": "Design System",
  "ghosttyTheme": "Solarized Dark"
}
```

## Command Reference

All commands are available through the Command Palette (`Cmd+Shift+P`):

### Terminal Commands
- `Command Central: Launch Terminal` - Launch terminal in current directory
- `Command Central: Launch Terminal Here` - Launch terminal at specific location
- `Command Central: Launch Terminal in Workspace` - Launch terminal in workspace root
- `Command Central: Configure Project` - Set up project-specific settings
- `Command Central: List Terminal Launchers` - Show all configured launchers
- `Command Central: Remove Terminal Launcher` - Remove a specific launcher
- `Command Central: Remove All Terminal Launchers` - Clear all launchers

### Git Sort Commands
- `Command Central: Enable Git Sort` - Enable git changes sorting
- `Command Central: Disable Git Sort` - Disable git changes sorting
- `Command Central: Refresh Sorted Changes` - Manually refresh the sorted view
- `Command Central: Change Sort Order` - Toggle between sort orders

## Troubleshooting

### Terminal App Not Working

If your custom terminal app isn't launching:

1. Verify the path is correct: `ls -la "/Applications/YourTerminal.app"`
2. Check the launcher script has execute permissions
3. Enable debug logging: Set `commandCentral.terminal.logLevel` to `"debug"`
4. Check the output channel: View → Output → Select "Command Central"

### Git Sort Not Showing

If the sorted changes view isn't appearing:

1. Ensure Git Sort is enabled: `commandCentral.gitSort.enabled: true`
2. Verify you have a git repository open
3. Check that the Git extension is enabled
4. Refresh the view: Run `Command Central: Refresh Sorted Changes`

### Configuration Not Taking Effect

1. Reload VS Code window: `Cmd+R` (in developer mode) or restart VS Code
2. Check for typos in setting names
3. Verify you're editing the correct settings file (user vs workspace)

## Migration from Previous Versions

### Automatic Migration

When you open a workspace with legacy configuration, the extension will offer to migrate your settings automatically. This migration will:

1. Convert `projectIcon` → `commandCentral.project.icon`
2. Convert `projectName` → `commandCentral.project.name`  
3. Convert `ghosttyTheme` → `commandCentral.terminal.theme`

### Manual Migration

If you prefer to migrate manually, update your `.vscode/settings.json`:

**Old Format:**
```json
{
  "projectIcon": "🚀",
  "projectName": "My Project",
  "ghosttyTheme": "GitHub Dark"
}
```

**New Format:**
```json
{
  "commandCentral.project.icon": "🚀",
  "commandCentral.project.name": "My Project",
  "commandCentral.terminal.theme": "GitHub Dark"
}
```

### Backward Compatibility

- Legacy settings are still read for compatibility
- New settings take precedence if both exist
- `commandCentral.terminal.terminalApp` renamed to `commandCentral.terminal.app`

## Security Considerations

- The `launcherPath` setting points to a script that must have execute permissions
- The `app` path is passed as an environment variable (`TERMINAL_APP`) to the launcher script
- Execution timeouts and buffer limits help prevent resource exhaustion

## Related Documentation

- [README.md](./README.md) - Quick start guide
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical architecture details
- [VS Code Settings Documentation](https://code.visualstudio.com/docs/getstarted/settings)