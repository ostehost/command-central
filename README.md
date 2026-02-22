<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=oste.command-central">
    <img src="https://partnerai.dev/images/logo-128.png" alt="Command Central" width="128" height="128">
  </a>
</p>

# Command Central

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/oste.command-central)](https://marketplace.visualstudio.com/items?itemName=oste.command-central)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/oste.command-central)](https://marketplace.visualstudio.com/items?itemName=oste.command-central)
[![CI](https://github.com/ostehost/command-central/actions/workflows/ci.yml/badge.svg)](https://github.com/ostehost/command-central/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Code changes, sorted by time

See what changed, in the order it changed.

[partnerai.dev](https://partnerai.dev/?utm_source=github&utm_medium=referral&utm_campaign=launch-2026-02&utm_content=readme-hero)

![Command Central showing three workspaces with time-grouped file changes](https://partnerai.dev/assets/hero.png)

## Install

```
ext install oste.command-central
```

Or search **"Command Central"** in the Extensions panel.

Works with **VS Code**, **Cursor**, and **Windsurf**.

## What it does

### Sorted by time, not name

Adjustable time groups. Minutes, hours, days.

![Time-grouped file changes](https://partnerai.dev/assets/hero.png)

### Staged vs. working

Toggle to separate staged from working.

![Staged and working changes split into clear groups](https://partnerai.dev/assets/git-status.png)

### Filter by extension

See only the file types that matter.

![Extension filter showing filtered files](https://partnerai.dev/assets/filter.png)

### Plus

- **Multi repo workspaces.** Each folder gets its own isolated view (up to 10).
- **Active file tracking.** Current file highlights in the tree as you work.
- **Two layout modes.** Sidebar for deep dives, Panel for cross project comparison.
- **Deleted file persistence.** Deleted files stay visible with stable ordering across sessions.
- **Emoji icons per project.** Set an icon per workspace in `.vscode/settings.json`.
- **Zero config.** Install and go. 297 tests passing, MIT licensed.

## You've been here

🤖 **Three agents running.**
Every file they touch, sorted by the minute.

🔍 **Agent went wide.**
Filter to .ts. Then to .css. Find what matters.

☕ **Morning after.**
What changed overnight, grouped by hour.

## Requirements

- VS Code **1.100.0** or higher (or Cursor / Windsurf equivalent)
- Git (built in)

## Configuration

See [CONFIG.md](./CONFIG.md) for the full settings reference. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `commandCentral.gitSort.enabled` | `true` | Enable time sorted git changes |
| `commandCentral.gitStatusGrouping.enabled` | `false` | Group by staged/working with time subgroups |
| `commandCentral.gitSort.fileTypeFilter` | `all` | Filter by file type |
| `commandCentral.trackActiveFile` | `true` | Highlight active file in tree |

## License

[MIT](./LICENSE)

Free and open source. Always.

A [Partner AI™](https://partnerai.dev) project.
