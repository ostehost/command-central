# Demo Video Script — Command Central v0.5.1-70

> 60-90 seconds, no narration, captions only. Screen recording of VS Code.

## Setup
- VS Code open with Command Central sidebar visible
- 3+ agents running in Ghostty terminals (different projects)
- At least one completed, one running, one failed/stopped

## Sequence

### Scene 1: Agent Discovery (0-15s)
**Caption:** "Command Central sees every AI agent — even ones in external terminals"
- Show Agent Status sidebar with 5+ agents listed
- Mix of running (hollow square), completed (green check), stopped (orange)
- Highlight: different projects, different backends (Claude, Codex)

### Scene 2: Click to Focus (15-25s)
**Caption:** "Click any agent → jump to its terminal"
- Click a running agent in the sidebar
- Ghostty terminal window comes to front with the correct tmux window
- Show the agent actively working

### Scene 3: Diff Review (25-40s)
**Caption:** "See exactly what each agent changed"
- Expand a completed agent's file list in sidebar
- Click a file → VS Code diff viewer opens
- Show +/- line counts in the tree

### Scene 4: TaskFlow Groups (40-50s)
**Caption:** "Workstream groups track multi-agent jobs"
- Show a TaskFlow group node: "ws-auth-refactor (2/3 complete)"
- Expand to show child tasks
- (If no real TaskFlow exists, skip this scene)

### Scene 5: Model + Fallback (50-60s)
**Caption:** "Know which model each agent is actually running"
- Show agent with "opus" label
- Show agent with "sonnet (fallback from opus)" indicator
- Highlight the model info in description

### Scene 6: Status Summary (60-70s)
**Caption:** "One glance. Every agent. Every terminal."
- Zoom out to show full sidebar
- Summary line: "12 agents · 2 working · 1 stopped · 9 done"
- Quick scroll through the list

### End Card (70-80s)
**Caption:** "Command Central — available now on VS Code Marketplace"
- Show marketplace badge
- GitHub link
- "Works with Claude Code, Codex CLI, Gemini CLI"

## Recording Notes
- Use screen recording tool (macOS Screenshot or OBS)
- 1920x1080 or 2560x1440
- Dark theme (VS Code default dark)
- No mouse cursor animation/effects
- Captions: white text, semi-transparent black background, bottom of frame
- Export: MP4 for GitHub, GIF for README (first 15s only)
