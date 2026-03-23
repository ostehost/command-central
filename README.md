# Command Central

> **The VS Code agent control tower.** Monitor all your AI coding agents from one sidebar — even ones running in external terminals that VS Code can't see.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/oste.command-central)](https://marketplace.visualstudio.com/items?itemName=oste.command-central)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/oste.command-central)](https://marketplace.visualstudio.com/items?itemName=oste.command-central)
[![Tests](https://img.shields.io/badge/tests-764%20passed-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## The Problem

You're running 3 Claude Code agents in terminal tabs, a Codex session in tmux, and you've lost track of which one finished, which one failed, and which one is still burning tokens. You Cmd+Tab between 6 windows trying to find the right terminal. Sound familiar?

## The Solution

Command Central puts every agent — regardless of which terminal app they're running in — into a single VS Code sidebar. One glance tells you what's running, what's done, and what needs attention.

<!-- TODO: Add screenshot/gif here before Marketplace publish -->

---

## Features

### 🤖 Agent Status Sidebar
- **Live status monitoring** — See running, completed, and failed agents at a glance
- **Click to focus** — Jump to any agent's terminal with one click
- **Auto-refresh** — Status updates every 5 seconds while agents are running (configurable)
- **Git context** — See the branch and last commit for each agent
- **Per-project emoji icons** — Visually distinguish agents across projects

### 📊 Agent Dashboard (Cmd+Shift+D)
- Full agent overview in a webview panel
- Running, completed, and failed counts
- Quick actions per agent

### 🔔 Notifications
- **Completion alerts** — Get notified when any agent finishes
- **Failure alerts** — Immediate notification on agent errors
- **Granular control** — Toggle completion, failure, and sound notifications independently
- **Status bar badge** — Running agent count always visible

### 📋 Activity Timeline
- History of agent events across sessions
- Configurable lookback window (default: 7 days)

### 📂 Git Sort (Agent Diff Tracker)
- **Time-sorted file changes** — Most recently modified files at the top
- **Multi-project support** — Up to 10 project slots for multi-root workspaces
- **Extension filter** — Filter by file type (`.ts`, `.py`, `.md`, etc.)
- **Status grouping** — Group by staged/unstaged with time-based subgroups
- **Full context menu** — Open diff, copy path, reveal in explorer, compare files

### ⚡ Agent Controls
- **Launch agents** from the sidebar (with Ghostty Launcher)
- **Kill running agents** directly from VS Code
- **View agent diffs** — See what files an agent changed
- **Open agent directory** — Jump to the agent's working directory
- **Capture output** — Stream agent stdout to an Output Channel

---

## Quick Start

### 1. Install

From the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=oste.command-central), or:

```
code --install-extension oste.command-central
```

### 2. Open a Project

Open any folder with a Git repository. The Command Central icon appears in the Activity Bar.

### 3. Monitor Agents

Command Central auto-detects your task registry from standard locations:

| Location | Priority |
|----------|----------|
| `${workspaceFolder}/.ghostty-launcher/tasks.json` | 1st (workspace-local) |
| `~/.config/ghostty-launcher/tasks.json` | 2nd (XDG standard) |
| `~/.ghostty-launcher/tasks.json` | 3rd (legacy) |

Or set a custom path: **Settings → Command Central: Agent Tasks File**

---

## How It Works

Command Central reads a `tasks.json` registry file that tracks agent sessions. Any tool that writes to this format gets full sidebar integration.

```jsonc
// Example tasks.json entry
{
  "version": 2,
  "tasks": {
    "agent-myproject-planner": {
      "status": "running",           // running | completed | failed | stopped
      "project": "my-project",
      "startedAt": "2026-03-22T21:00:00Z",
      "cwd": "/Users/you/projects/my-project",
      "command": "claude --print 'Implement auth module'"
    }
  }
}
```

### Works With

| Agent | Integration |
|-------|-------------|
| **Claude Code** (Anthropic) | ✅ Full support via Ghostty Launcher |
| **Codex CLI** (OpenAI) | ✅ Full support via Ghostty Launcher |
| **Any CLI agent** | ✅ Anything that writes tasks.json |
| **Ghostty Launcher** | ✅ Full integration (auto-tracking, hooks, notifications) |

**Coming soon (v0.5.0):** Auto-discovery of Claude Code processes running in *any* terminal — no configuration needed. This is the feature that makes Command Central unique: VS Code's native Agent Sessions View only sees agents it spawned. Command Central will see all of them.

---

## Keyboard Shortcuts

| Command | macOS | Windows/Linux | Description |
|---------|-------|---------------|-------------|
| Open Command Central | Cmd+Shift+C | Ctrl+Shift+C | Focus the sidebar |
| Focus Running Agent | Cmd+Shift+U | Ctrl+Shift+U | Jump to first running agent |
| Agent Dashboard | Cmd+Shift+D | Ctrl+Shift+D | Open the dashboard panel |

**When sidebar is focused:**
| Key | Action |
|-----|--------|
| F | Filter files by extension |
| G | Toggle grouping panel |

---

## Configuration

All settings are under `commandCentral.*` in VS Code Settings (Cmd+,).

### Agent Monitoring

| Setting | Default | Description |
|---------|---------|-------------|
| `agentTasksFile` | `""` (auto-detect) | Path to tasks.json registry |
| `agentStatus.autoRefreshMs` | `5000` | Refresh interval while agents run |
| `agentStatus.notifications` | `true` | Master notification toggle |
| `notifications.onCompletion` | `true` | Notify on agent completion |
| `notifications.onFailure` | `true` | Notify on agent failure |
| `notifications.sound` | `false` | Play sound with notifications |
| `activityTimeline.enabled` | `true` | Show activity timeline view |
| `activityTimeline.lookbackDays` | `7` | Days of history to display |

### Git Sort

| Setting | Default | Description |
|---------|---------|-------------|
| `gitSort.enabled` | `true` | Enable time-sorted file view |
| `gitSort.fileTypeFilter` | `"all"` | Filter: `all`, `custom` |
| `gitSort.customFileTypes` | `[]` | Custom extensions: `[".vue", ".svelte"]` |
| `gitStatusGrouping.enabled` | `false` | Group by staged/unstaged |
| `trackActiveFile` | `true` | Highlight active file in tree |

### Display

| Setting | Default | Description |
|---------|---------|-------------|
| `project.name` | workspace name | Display name for this project |
| `project.icon` | — | Emoji icon for this project |
| `projects` | `[]` | Per-project emoji mappings |
| `statusBar.showProjectIcon` | `true` | Show icon in status bar |
| `statusBar.priority` | `10000` | Status bar position (higher = left) |
| `ghostty.launcherPath` | `""` (auto-detect) | Path to Ghostty Launcher |

---

## Requirements

- **VS Code 1.100.0+** (or compatible: Cursor, Windsurf, etc.)
- **Git** — for Git Sort features
- **Node 18+** — runtime requirement

### Optional

- [**Ghostty Launcher**](https://github.com/ostehost/ghostty-launcher) — for full agent lifecycle management (launch, auto-track, hooks, notifications). Without it, you can still monitor any agent that writes to tasks.json.

---

## Roadmap

| Version | Milestone | Status |
|---------|-----------|--------|
| v0.3.x | Agent sidebar, dashboard, notifications, Git Sort | ✅ Shipped |
| v0.4.0 | External user onboarding, Marketplace listing | 🔨 In Progress |
| v0.5.0 | **Auto-discovery** — detect Claude Code in any terminal | 📋 Planned |
| v0.7.0 | Launch — Show HN, first 100 users | 📋 Planned |
| v0.8.0 | Competitive parity — grouping, output viewer, lifecycle | 📋 Planned |
| v1.0 | Pro tier — cost tracking, stuck detection | 📋 Planned |

See [ROADMAP.md](./ROADMAP.md) for the full plan and [CHANGELOG.md](./CHANGELOG.md) for release history.

---

## Telemetry

Command Central collects anonymous usage data to improve the extension. We track:

- Extension activation and feature usage counts
- VS Code version, OS, extension version

We do **NOT** collect: file names, repository names, code content, or any personal data.

Disable via: Settings → Command Central → Telemetry: Enabled (uncheck), or set VS Code's `telemetry.telemetryLevel` to `off`.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing, and PR guidelines.

```bash
# Clone and install
git clone https://github.com/ostehost/command-central.git
cd command-central
bun install

# Run tests (674 tests, 1402 assertions)
bun test

# Build VSIX
just dist
```

---

## License

[MIT](./LICENSE) — Free and open source. Always.

---

**Stop managing terminals. Start managing agents.**
