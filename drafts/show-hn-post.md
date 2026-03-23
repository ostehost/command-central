# Show HN: Command Central – See all your Claude Code agents in VS Code, even external ones

I've been running 3-5 Claude Code agents in parallel across Ghostty terminals, tmux sessions, and VS Code's built-in terminal. The problem: VS Code's native Agent Sessions View only sees agents *it* spawned. The ones in external terminals? Invisible.

Command Central is a VS Code extension that puts every agent — regardless of which terminal app they're running in — into a single sidebar. One glance shows what's running, what's done, and what needs attention.

**What it does:**
- Auto-discovers running Claude Code processes via `ps` scanning
- Watches `~/.claude/` for active session files
- Merges discovered agents with task-registry-managed agents
- Click any agent → focuses its terminal (Ghostty, iTerm2, tmux, etc.)
- Git context per agent (branch, last commit)
- Completion/failure notifications with sound
- Agent diff tracker: time-sorted file changes across up to 10 projects

**The unique thing:** it sees agents in *external* terminals. Everything else (dmux, cmux, FleetCode) either replaces your terminal or only tracks agents it launched. This is an observer — it finds agents you're already running and puts them in one place.

**Tech:** TypeScript, VS Code Extension API, `bun test` (764 tests). No runtime dependencies. MIT licensed.

VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=oste.command-central
GitHub: https://github.com/ostehost/command-central

Looking for feedback on the discovery mechanism and what features would make this useful for your multi-agent workflow.
