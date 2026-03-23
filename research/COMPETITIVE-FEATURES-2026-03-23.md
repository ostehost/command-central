# Competitive Feature Analysis — March 2026

## The Landscape

Eight tools now compete for the "multi-agent control" space. They fall into three categories:

### Category 1: Terminal Replacements
These tools **replace your terminal** with their own. You must launch agents through them.

| Tool | Type | Key Features | Limitation |
|------|------|-------------|------------|
| **dmux** (1.2K+ ⭐) | CLI/tmux wrapper | Git worktree isolation, lifecycle hooks (pre-create/pre-merge/post-merge), auto branch naming via OpenRouter, multi-agent parallel | Terminal-only. No GUI. No visibility into agents launched elsewhere. |
| **cmux** | Native macOS app (libghostty) | Vertical tabs, notification rings on panes, split panes, socket API, GPU-rendered | macOS only. Must use cmux as your terminal. Can't see agents in VS Code or other terminals. |
| **Emdash** (YC W26, 60K+ downloads) | Electron desktop app | Git worktree per agent, GitHub/Jira/Linear integration, diff preview before commit, 20+ agent CLI support, SSH remote | Separate app. Not in your editor. Must launch agents through Emdash. |
| **amux** | tmux + web dashboard | Browser/phone dashboard, headless Claude Code sessions, kanban board | Requires its own tmux sessions. Can't observe external agents. |

### Category 2: VS Code Extensions (Competitors)
These live inside VS Code but focus on different problems.

| Tool | Type | Key Features | Limitation |
|------|------|-------------|------------|
| **Pixel Agents** | VS Code ext | Virtual office pixel art, agent activity visualization, sub-agent tree | Novelty UX (pixel art). No process discovery. Only tracks VS Code-spawned agents. |
| **Agent Kanban** | VS Code ext | Markdown-based kanban, GitOps-friendly task board | Task management, not agent monitoring. No live agent status. |
| **VS Code Agent Sessions** | Built-in | Native agent panel in VS Code | Only sees agents VS Code spawned. External terminal agents invisible. |

### Category 3: The Observer (Command Central)
**Command Central** is the only tool that **discovers agents it didn't launch.**

| Tool | Type | Key Features | Unique Advantage |
|------|------|-------------|-----------------|
| **Command Central** | VS Code ext | `ps` scanning, `~/.claude/` session watching, click-to-focus any terminal, git context per agent, completion notifications, time-sorted diff tracker | Works with your existing setup. No workflow changes. Finds agents in Ghostty, iTerm2, tmux, Terminal.app — anything. |

## Feature Comparison Matrix

| Feature | dmux | cmux | Emdash | amux | CC (now) | CC (vision) |
|---------|------|------|--------|------|----------|-------------|
| Auto-discover running agents | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Works inside VS Code | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Git worktree isolation | ✅ | ❌ | ✅ | ❌ | ❌ | 🔮 |
| Lifecycle hooks | ✅ | ❌ | ❌ | ❌ | ❌ | 🔮 |
| Agent output viewer | ❌ | ✅ (pane) | ✅ | ✅ (web) | ❌ | 🔮 |
| Click-to-focus terminal | ❌ | N/A | N/A | ❌ | ✅ | ✅ |
| Git context per agent | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Diff preview per agent | ❌ | ❌ | ✅ | ❌ | ✅ (time-sorted) | ✅ |
| Completion notifications | ❌ | ✅ (ring) | ❌ | ✅ | ✅ | ✅ |
| Session grouping | ❌ | ✅ (tabs) | ✅ | ✅ | ❌ | 🔮 |
| Issue tracker integration | ❌ | ❌ | ✅ (GH/Jira/Linear) | ❌ | ❌ | 🔮 |
| Multi-agent CLI support | ✅ (11) | ✅ | ✅ (20+) | ❌ | ✅ (any) | ✅ |
| No separate app required | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Status bar summary | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Stuck agent detection | ❌ | ❌ | ❌ | ❌ | ❌ | 🔮 |

Legend: ✅ = has it | ❌ = doesn't | 🔮 = planned/vision

## Command Central's Unique Position

**The only tool that observes without controlling.**

Every competitor requires you to launch agents through their system. Command Central finds agents you're *already running*. This is the wedge:

1. **Zero workflow change.** Keep using whatever terminal you want.
2. **Lives where you code.** VS Code sidebar, not a separate window.
3. **Terminal-agnostic discovery.** `ps` scanning + session file watching works with any terminal app.
4. **Complements other tools.** You can use dmux for launching AND CC for monitoring. They're not mutually exclusive.

## Vision Features (for SVG mockups)

These are UI concepts that show where CC could go — NOT built features:

### 1. Agent Status Sidebar (BUILT ✅)
- Tree view with running/completed/failed agents
- Status icons, elapsed time, project name
- Click to focus terminal
- Git branch and last commit per agent

### 2. Agent Output Preview (VISION 🔮)
- Inline preview of agent's recent terminal output
- Last 5-10 lines visible without switching windows
- "Show full output" button opens terminal

### 3. Agent Diff Summary (VISION 🔮)
- Per-agent file change summary: "touched 12 files, +340/-87"
- Expandable to see individual file diffs
- "Review before merge" workflow

### 4. Session Grouping (VISION 🔮)
- Group by: project, role, status
- Collapsible groups in sidebar
- Visual hierarchy for 5+ agent workflows

### 5. Stuck Agent Detection (VISION 🔮)
- Yellow warning icon when agent hasn't produced output in N minutes
- "Agent may be stuck" tooltip with suggested actions
- Configurable threshold
