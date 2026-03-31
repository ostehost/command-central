# Show HN: Command Central – See all your AI coding agents in VS Code, even external ones

I run 3-10 Claude Code and Codex agents in parallel across Ghostty terminals, tmux sessions, and VS Code's built-in terminal. The problem: VS Code's native Agent Sessions View only sees agents *it* spawned. The ones in external terminals? Invisible.

Command Central is a VS Code extension that puts every AI coding agent — Claude Code, Codex, Gemini — into a single sidebar regardless of which terminal they're running in.

**What it does:**
- Auto-discovers running Claude Code, Codex, and Gemini processes via `ps` scanning and `~/.claude/` session file watching
- Merges discovered agents with task-registry-managed agents into one unified list
- Click any agent → focuses its terminal (Ghostty, iTerm2, tmux, Terminal.app)
- Kill or restart agents directly from the sidebar
- View diffs: per-file change lists with +/- line counts
- See what each agent is working on (prompt summary display)
- Agent badges: Claude 🟣 / Codex 🟢 / Gemini 🔵
- Stuck-agent detection when an agent appears frozen
- Git context per agent: branch, commit hash, working tree status

**The unique thing:** it sees agents in *external* terminals. Everything else (dmux, cmux, FleetCode) either replaces your terminal or only tracks agents it launched. This is an observer — it finds agents you're already running and puts them in one place.

**Tech:** TypeScript, VS Code Extension API, `bun test` (1100+ tests, zero failures). No runtime dependencies. MIT licensed.

VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=oste.command-central
GitHub: https://github.com/ostehost/command-central

Looking for feedback on the discovery mechanism and what features would make this useful for your multi-agent workflow.
