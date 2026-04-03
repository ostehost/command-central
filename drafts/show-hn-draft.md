# Show HN: Command Central – See all your AI coding agents in one VS Code sidebar

I run 5-10 AI coding agents at once (Claude Code, Codex CLI, Gemini CLI) across multiple terminal windows. VS Code's built-in Agent Sessions only sees agents it spawned — not the ones running in Ghostty, iTerm2, or tmux.

**Command Central** is a VS Code extension that auto-discovers every Claude, Codex, and Gemini agent running anywhere on your machine and puts them in one sidebar.

## What it does

- **Auto-discovers agents** across all terminals (Ghostty, iTerm2, Terminal.app, tmux, VS Code)
- **Groups by project** with custom emoji icons in your macOS Dock
- **Shows status** — Running / Failed / Completed with time sub-groups (Today, Yesterday, Older)
- **Per-agent model display** — see `opus`, `codex-5.4`, or `gemini-pro` inline on each agent
- **Click to focus** — click any agent → lands in the exact terminal window and tab
- **Diff summary** — `6 files · +81/-15` per agent without leaving VS Code
- **Dead agent logs** — click a failed agent → opens its transcript in an editor tab
- **Stale detection** — catches zombie agents that died without signaling completion

## Why I built it

I got tired of Cmd+Tab-ing through 8 terminal windows trying to remember which agent was working on what. The existing tools (dmux, cmux) are terminal-only. I wanted this in VS Code where I already live.

## Technical details

- VS Code extension, MIT licensed, 1160+ tests
- Agent discovery via `ps` scanning + `~/.claude/sessions/` file watching + Ghostty Launcher task registry
- Zero config needed — install and it finds your agents
- Works with any terminal emulator, not just Ghostty

Install: https://marketplace.visualstudio.com/items?itemName=oste.command-central
Source: https://github.com/ostehost/command-central
Site: https://cc.partnerai.dev

I'd love feedback on what's missing or what you'd want from an agent control tower.
