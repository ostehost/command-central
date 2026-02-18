# Command Central

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/oste.command-central)](https://marketplace.visualstudio.com/items?itemName=oste.command-central)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/oste.command-central)](https://marketplace.visualstudio.com/items?itemName=oste.command-central)
[![CI](https://github.com/ostehost/command-central/actions/workflows/ci.yml/badge.svg)](https://github.com/ostehost/command-central/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Know what changed in your codebase while you were away.**

<!-- SCREENSHOT: hero.png -->

Open a project after a day, a week, or a month — instantly see what happened. Git changes sorted by time, not alphabetically. Works for your own coding sessions and for catching up after AI agents make changes.

## Install

```
ext install oste.command-central
```

Or search **"Command Central"** in VS Code Extensions.

## Features

- **Time-grouped changes** — Today, Yesterday, Last 7 days, Last 30 days. No more scrolling `git log`.
- **File type filtering** — Focus on code, config, docs, tests, or custom extensions.
- **Active file tracking** — Current file auto-highlights in the tree view as you work.
- **Multi-root workspace support** — Each workspace folder gets its own isolated git tracking view (up to 10).
- **Deleted file persistence** — Deleted files tracked with stable ordering across sessions via SQLite.

640 tests. Passes CI on every commit.

## Requirements

- VS Code **1.100.0** or higher
- Git (built-in VS Code extension)

## Configuration

See [CONFIG.md](./CONFIG.md) for the full settings reference. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `commandCentral.gitSort.enabled` | `true` | Enable time-sorted git changes |
| `commandCentral.trackActiveFile` | `true` | Auto-highlight active file in tree |
| `commandCentral.gitSort.fileTypeFilter` | `all` | Filter by file type |

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details.

## License

[MIT](./LICENSE)
