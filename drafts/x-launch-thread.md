# X/Twitter Launch Thread

## Tweet 1 (Hook)
Running 5 Claude Code agents in parallel and losing track of which ones finished?

I built a VS Code extension that finds ALL your agents — even ones running in external terminals VS Code can't see.

🧵 Quick thread on Command Central:

## Tweet 2 (Problem)
The problem: VS Code only sees agents it spawned.

But if you're using Ghostty, iTerm2, tmux, or plain Terminal.app, those agents are invisible to VS Code.

You end up Cmd+Tab'ing between 6 windows trying to find the right terminal.

## Tweet 3 (Solution)
Command Central auto-discovers running Claude Code processes and puts them all in one sidebar.

Click any agent → jump to its terminal.
See git branch, last commit, and elapsed time.
Get notifications when agents complete or fail.

[screenshot: agent sidebar with 3-4 agents visible]

## Tweet 4 (Differentiator)
What makes it different from dmux/cmux/FleetCode:

It's an *observer*, not a launcher. It finds agents you're already running.

Other tools either replace your terminal or only track agents they started. CC works with whatever you've got.

## Tweet 5 (Numbers)
- 764 tests, 0 failures
- Auto-discovers via `ps` scanning + `~/.claude/` file watching
- Merges with task-registry-managed agents
- Up to 10 project slots for multi-root workspaces
- MIT licensed, no runtime deps

## Tweet 6 (CTA)
Try it:
```
code --install-extension oste.command-central
```

Or search "Command Central" in VS Code Extensions.

GitHub: github.com/ostehost/command-central

Looking for feedback — what would make this useful for your multi-agent workflow?
