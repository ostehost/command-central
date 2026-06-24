# Command Central Configuration Guide

Command Central settings live under `commandCentral.*` in VS Code settings.

## Common settings

```json
{
  "commandCentral.project.icon": "🚀",
  "commandCentral.project.name": "My Project",
  "commandCentral.gitSort.enabled": true,
  "commandCentral.ghostty.launcherPath": "/path/to/ghostty-launcher/launcher"
}
```

## Ghostty launcher

| Setting | Type | Default | Scope | Description |
|---|---:|---|---|---|
| `commandCentral.ghostty.launcherPath` | string | `""` | machine | Optional path to the Ghostty Launcher `launcher` binary. Leave empty to auto-detect from `PATH`. |

The old `commandCentral.terminal.launcherPath` and `commandCentral.terminal.app` settings are no longer contributed. Use `commandCentral.ghostty.launcherPath` for a custom launcher binary.

## Agent Status notifications

| Setting | Type | Default | Scope | Description |
|---|---:|---|---|---|
| `commandCentral.agentStatus.notifications` | boolean | `true` | window | Master toggle for Agent Status notifications. |
| `commandCentral.notifications.onCompletion` | boolean | `true` | window | Show a notification when an agent completes. |
| `commandCentral.notifications.onFailure` | boolean | `true` | window | Show a notification when an agent fails. |
| `commandCentral.notifications.sound` | boolean | `false` | window | Play a sound when an agent completes or fails. |

`commandCentral.notifications.autoDismissSeconds` was removed because VS Code `showInformationMessage` notifications cannot be programmatically auto-dismissed.

## Workspace Trust

Command Central declares limited untrusted-workspace support:

- Read-only features such as Agent Status, Git Sort, and project icons can run in untrusted workspaces.
- Ghostty project-terminal operations are blocked until the workspace is trusted because they execute a launcher subprocess.
- `commandCentral.ghostty.launcherPath` is listed in `capabilities.untrustedWorkspaces.restrictedConfigurations` so workspace settings cannot silently redirect the executable path in untrusted workspaces.

## Other contributed settings

The full contributed setting list is the source of truth in `package.json` under `contributes.configuration.properties`.

Frequently used settings include:

- `commandCentral.project.icon`
- `commandCentral.project.name`
- `commandCentral.project.group`
- `commandCentral.gitSort.enabled`
- `commandCentral.gitSort.fileTypeFilter`
- `commandCentral.trackActiveFile`
- `commandCentral.fileFilter.persistence`
- `commandCentral.statusBar.showProjectIcon`
- `commandCentral.legacyLauncherTasks.enabled`
- `commandCentral.agentTasksFile`
- `commandCentral.agentTasksFiles`
- `commandCentral.laneRegistry.files`
- `commandCentral.releaseGeneration.file`
- `commandCentral.agentStatus.autoRefreshMs`
- `commandCentral.agentStatus.stuckThresholdMinutes`
- `commandCentral.agentStatus.groupByProject`
- `commandCentral.agentStatus.completedTaskLimit`
- `commandCentral.discovery.enabled`
- `commandCentral.discovery.pollInterval`
- `commandCentral.cron.enabled`
- `commandCentral.cron.refreshIntervalMs`
- `commandCentral.cron.showDisabled`

## Troubleshooting

- For launcher problems, verify the binary path: `commandCentral.ghostty.launcherPath`.
- For notification volume, disable `commandCentral.agentStatus.notifications` or the completion/failure toggles.
- If a Ghostty terminal command is blocked, trust the workspace first.
