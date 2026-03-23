# Command Central

> The VS Code agent control tower. See all your AI coding agents from one sidebar.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/oste.command-central)](https://marketplace.visualstudio.com/items?itemName=oste.command-central)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/oste.command-central)](https://marketplace.visualstudio.com/items?itemName=oste.command-central)
[![CI](https://github.com/ostehost/command-central/actions/workflows/ci.yml/badge.svg)](https://github.com/ostehost/command-central/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What It Does

Command Central gives you a unified view of all your AI coding agents running in terminals — even ones VS Code can't see.

### Agent Sidebar
- **Live agent monitoring** — See running, completed, and failed agents at a glance
- **Click to focus** — Jump to any agent's terminal with one click
- **Status bar badge** — Running agent count always visible
- **Completion notifications** — Get notified when agents finish or fail
- **Agent Dashboard** — Full overview via Cmd+Shift+D

### Git Sort (Agent Diff Tracker)
- **Time-sorted file changes** — See what changed most recently at the top
- **Agent-aware** — Perfect for reviewing multi-agent coding sessions
- **Staged & unstaged** — Full Git status integration

## Quick Start

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=oste.command-central)
2. Open a project with a Git repository
3. Look for the Command Central icon in the Activity Bar

### Agent Monitoring Setup

To monitor AI agents, configure the path to your task registry:

1. Open Settings (Cmd+,)
2. Search for "Command Central Tasks"
3. Set the path to your `tasks.json` file

Or let Command Central auto-detect from standard locations:
- `${workspaceFolder}/.ghostty-launcher/tasks.json`
- `~/.config/ghostty-launcher/tasks.json`
- `~/.ghostty-launcher/tasks.json`

### Works With
- **Claude Code** (Anthropic)
- **Codex CLI** (OpenAI)
- **Any agent** that writes to a tasks.json registry
- **Ghostty Launcher** for full integration (auto-tracking, notifications, dashboard)

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Focus Running Agent | Cmd+Shift+U | Jump to first running agent's terminal |
| Agent Dashboard | Cmd+Shift+D | Open the agent overview panel |
| Open Command Central | Cmd+Shift+C | Focus the sidebar |

## Requirements

- VS Code 1.100.0+ (or Cursor / Windsurf equivalent)
- Git (for Git Sort features)
- Optional: [Ghostty Launcher](https://github.com/ostehost/ghostty-launcher) for full agent integration

## License

[MIT](./LICENSE)

Free and open source. Always.
