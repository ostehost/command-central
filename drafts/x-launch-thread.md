# X/Twitter Launch Thread

## Tweet 1 (Hook)
Running 5+ Claude Code or Codex agents in parallel and losing track of which ones finished?

I built a VS Code extension that finds ALL your AI coding agents — even ones running in external terminals VS Code can't see.

🧵 Quick thread on Command Central:

## Tweet 2 (Problem)
VS Code only sees agents it spawned.

But if you're using Ghostty, iTerm2, tmux, or Terminal.app, those agents are invisible to VS Code.

You end up Cmd+Tab'ing between 8 windows hunting for the right terminal. "Wait, which one was the auth fix?"

## Tweet 3 (Solution)
Command Central auto-discovers running Claude Code, Codex, and Gemini agents. One sidebar. Every agent.

• Click → jump to its terminal
• Kill/restart from sidebar
• See diffs: per-file changes with +/- counts
• Prompt display: what each agent is working on
• Agent badges: Claude 🟣 / Codex 🟢 / Gemini 🔵

[screenshot: agent sidebar with 4-5 agents visible, mixed statuses]

## Tweet 4 (Differentiator)
What makes it different from dmux/cmux/FleetCode:

It's an *observer*, not a launcher. It finds agents you're already running.

Other tools replace your terminal or only track agents they started. CC works with whatever setup you've got.

## Tweet 5 (Numbers)
• 1100+ tests, 0 failures
• Auto-discovers via `ps` + `~/.claude/` session file watching
• Claude Code, Codex, and Gemini support
• Stuck-agent detection
• MIT licensed, no runtime deps
• Built entirely by AI agents managed by AI agents (yes, it's turtles all the way down)

## Tweet 6 (CTA)
Try it:
```
code --install-extension oste.command-central
```

Or search "Command Central" in VS Code Extensions.

GitHub: github.com/ostehost/command-central

Feedback welcome — what would make this useful for your multi-agent workflow?
