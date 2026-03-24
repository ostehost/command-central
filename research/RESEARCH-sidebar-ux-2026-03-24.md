# Sidebar UX Competitive Analysis — Agent Detail Views

> Research Date: 2026-03-24
> Purpose: Drive Command Central sidebar redesign
> Sources: 8 tools analyzed across GitHub repos, documentation, changelogs, and web research

---

## Executive Summary

Across 8 competing tools, a clear pattern emerges for what users expect when clicking an agent:

**The user's question:** "What did this agent do, and what should I do next?"

Every successful tool answers this with three layers of progressive disclosure:
1. **List view:** Status indicator + name + project + duration (scannable at a glance)
2. **Detail view:** Prompt text + diff summary + actions (click to expand)
3. **Deep dive:** Full terminal + file-by-file diffs + conversation history (on demand)

### Universal Patterns (Present in All/Most Tools)

| Pattern | Prevalence | Why It Matters |
|---------|------------|----------------|
| **3-state lifecycle** (working / needs attention / done) | 8/8 | Users need exactly three buckets for triage |
| **Git worktree isolation** as fundamental unit | 7/8 | Branch name is always surfaced — it's the identity |
| **Progressive disclosure** (list → detail → full) | 8/8 | Never dump everything at once |
| **Real-time status updates** | 8/8 | Hooks, WebSockets, or polling — all real-time |
| **Diff summary visible early** | 6/8 | "What changed" is the #1 useful field after status |
| **Lifecycle controls** (kill, merge, restart) | 7/8 | Users want to DO things, not just READ things |
| **Token/cost display** | 0/8 | **Nobody shows this** — it's a gap/opportunity |

### Best-in-Class Patterns

- **Superset's 3-color status** (amber/red/green) — clearest at-a-glance lifecycle indicator
- **Nimbalyst's files-on-card** — see modified file list without drilling in
- **Emdash's editable diff viewer** — review AND fix in the same panel
- **Cursor's multi-agent comparison** — color-coded agreement across parallel agents
- **Kanban Code's embedded terminal** — full SwiftTerm in the detail drawer
- **ccmanager's worktree-centric model** — copy session data between worktrees

---

## Per-Tool Detailed Findings

### 1. Emdash (YC W26, Open Source, Electron)
**Source:** https://github.com/generalaction/emdash | https://docs.emdash.sh

#### Agent List View — 3-Column Kanban
| Column | Meaning |
|--------|---------|
| **To-do** | Tasks not yet started |
| **In-progress** | Agent actively working (spinner visible) |
| **Ready for review** | Completed, changes to review |

**Per-card fields (always visible):**
- Task name (auto-inferred from context or user-specified)
- Branch name
- Provider/agent type (Claude Code, Codex, etc.)
- Activity spinner when busy

**On hover:** File modification summary (files changed, lines +/-)

**Status transitions:** Automatic — cards move between columns based on agent lifecycle events (terminal exit, changes detected, PR created). Manual drag-drop also supported.

**Project dashboard PR list** shows CI check status, reviewer status, line change counts.

#### Agent Detail View — Full-Screen Multi-Panel
Clicking a card opens a full-screen layout:

**Main panel:**
- Embedded terminal (agent conversation/shell output), expandable to full-screen modal
- Multi-chat tabs (multiple conversation providers per worktree)
- File editor (Monaco-based, direct editing)
- File explorer (persists state and opened tabs per task)

**Right sidebar — Diff View** (polls every 5 seconds):
- Header: total files changed, overall additions/deletions, PR status
- Per-file list: file path + type icon, lines added (green) / removed (red), staged/unstaged
- Actions per file: stage (+), unstage/revert (undo), click to open diff viewer
- **Diff viewer is editable** — fix code directly in the diff view
- Commit message field → Enter to commit and push
- "Create PR" button appears after pushing

**Right sidebar — Checks/CI panel:**
- CI/CD check statuses (GitHub Actions)
- PR merge section (pinned to bottom)
- Comments popover with in-memory draft store
- PR reviewer status

**Additional:** Task timer in sidebar (elapsed time), optional resource monitor (RAM/CPU).

#### Actions Available
- Kill/stop agent
- Stage/unstage/revert individual files
- Edit files directly in diff viewer
- Commit and push with message
- Create PR from within the app
- Merge into main (confirmation modal)
- Auto-approve toggle (badge visible on task)
- Pull tasks from Linear/GitHub/Jira

#### Key Insight
Emdash treats the detail view as a **workflow**, not just information. You can go from "review" → "fix" → "commit" → "PR" → "merge" without leaving the panel. The editable diff is a standout.

---

### 2. dmux (Terminal Multiplexer TUI, MIT)
**Source:** https://github.com/standardagents/dmux | https://dmux.ai

#### Agent List View — tmux Panes
No cards or GUI — the "list view" is the tmux session with multiple panes.

**Per-pane visual indicators:**
- Pane content = raw terminal output (no overlaid metadata)
- Active pane: darker background + **blue border**
- Branch name visible in pane title (AI-generated via OpenRouter)
- Agent type visible in pane label

**dmux control overlay** (TUI layer above tmux):
- Pane list with task names
- Branch name, project, visibility state (hidden/visible)
- Merge readiness status
- macOS native notifications for background pane activity

**Project filtering:** Press `P` to isolate one project's panes.

#### Agent Detail View — Raw Terminal + File Browser
Focusing a pane IS the detail view. Supplementary:

**File browser** (press `f`): Inspect worktree files, search, preview code and diffs inline.

**Pane menu** (press `m`): Merge workflow, close/cleanup.

#### Actions Available
| Key | Action |
|-----|--------|
| `n` | New pane (prompt for task, select agent, creates worktree) |
| `j`/`Enter` | Jump to / focus pane |
| `m` | Merge (auto-commits + merges to main + cleans worktree) |
| `f` | File browser for this pane's worktree |
| `x` | Close/terminate pane |
| `h` | Hide pane / `H` hide all others |
| `P` | Filter to one project |

Lifecycle hooks: Scripts on worktree create, pre-merge, post-merge.

#### Key Insight
dmux deliberately avoids metadata overhead — appeals to terminal-native devs who want **zero abstraction**. The one-key merge flow (`m`) is the standout: one keypress goes from "done" to "merged."

---

### 3. Nimbalyst (Desktop + iOS, Native)
**Source:** https://nimbalyst.com | https://github.com/Nimbalyst/nimbalyst

#### Agent List View — 5-Column Kanban
| Column | Meaning |
|--------|---------|
| **Backlog** | Sessions awaiting agent assignment |
| **Planning** | Planning phase |
| **Implementing** | Actively running |
| **Waiting** | Requires user input |
| **Review / Complete** | Finished, pending approval |

**Per-card fields (always visible):**
- Session name (task title)
- Project identifier
- Agent type (Claude Code, Codex, etc.)
- Last activity timestamp
- Color-coded status indicator
- **Files modified list** — "every session tracks a list of files it created or modified. You see this list at a glance on the session card." **This is unique** — no other tool shows file lists on the card itself.

**Status transitions:** Automatic — agent starts → Implementing; agent asks question → Waiting; finished → Review.

**Filtering:** Tag-based (project, agent type, status, custom tags). `Cmd+Shift+K` shortcut.

#### Agent Detail View — 3-Panel Layout
**Panel 1 — Agent Conversation:**
- Full conversation history
- Interactive agent questions displayed inline
- Reply via text or voice input

**Panel 2 — File Edits Sidebar:**
- Files modified in session (grouped)
- Click any file → built-in editor with diff view
- Visual WYSIWYG diff (red/green)
- Git state management per file
- **"AI git commit"** button — generates commit message from changes

**Panel 3 — Task/Queue Panel:**
- Linked tasks with status, tags, priority
- Plans, bugs, features associated with session
- Agent auto-updates task states
- Queue management: add next tasks without interrupting current session

**Mobile (iOS):** Active session list, code with diffs, swipe-to-approve changes, push notifications.

#### Actions Available
- Reply to agent questions (text or voice)
- Approve/reject file changes (mobile: swipe gesture)
- "Approve and merge" from the board
- Drag-drop between columns
- Tag and filter sessions
- Queue next tasks while agent running
- Push notifications for attention requests

#### Key Insight
Nimbalyst's **files-on-card** approach is the most immediately useful for understanding agent scope at a glance. The 3-panel detail view answers "what happened," "what changed," and "what's next" simultaneously.

---

### 4. Superset (Desktop IDE, Apache 2.0)
**Source:** https://github.com/superset-sh/superset | https://superset.sh

#### Agent List View — Workspace Sidebar
**Per-workspace entry (always visible):**
- Workspace name (customizable)
- Agent icon (Claude, Codex, Gemini, Cursor — iconified by type)
- Task description
- **3-color status indicator:** amber = working, red = permission needed, green = ready for review
- Time elapsed (e.g., "30m", "45m")
- **Code change metrics:** `+93−18` format (lines added/removed)

**Hover cards reveal:** Full status detail, diff summary, timestamps, PR reviewers, reopen states.

**PR status in Changes view:** Icon + PR number → GitHub link, color-coded (green=open, violet=merged, red=closed, muted=draft). Inline Linear issue pills.

**Status click behavior:** Clicking status indicator changes state (review → idle, permission → working).

#### Agent Detail View — Workspace View
**Terminal pane(s):** Full agent output, tab support, split panes.

**Changes panel** (`Cmd+L`):
- Hierarchical file tree with search
- File-level modifications list
- Unstaged changes preview
- CI check statuses inline
- **Review tab:** PR comment management — read, filter, respond to review comments directly

**Chat panel:** Model picker, thinking level control (Off → Max), rich MCP tool call rendering (collapsible panels, file diffs, bash output as specialized cards).

**Workspace creation:** Project selection, prompt input, image attachments, PR references, Linear issue links.

#### Actions Available
- `Cmd+N`: New workspace, `Cmd+1-9`: Switch workspaces
- `Cmd+O`: Open in external IDE (VS Code, Cursor, Xcode, JetBrains)
- Stop agent (Run button)
- Respond to PR review comments inline
- Port forwarding quick actions
- Per-agent settings: enabled toggle, command, prompt suffix, model override

#### Key Insight
Superset's **3-color system** (amber/red/green) is the clearest at-a-glance lifecycle indicator across all 8 tools. The hover cards are uniquely information-dense. Inline PR review (read + respond without leaving the app) is distinctive.

---

### 5. Kanban Code (Native macOS, SwiftUI)
**Source:** https://github.com/langwatch/kanban-code

#### Agent List View — 6-Column Auto-Transitioning Kanban
Columns: **Backlog → In Progress → Waiting → In Review → Done → All Sessions**

Transitions driven by Claude Code hooks — fully automatic.

**Per-card fields:**
- Session/task title
- Git worktree name and branch
- PR status badge (draft, open, merged, closed)
- CI check run indicators (pass/fail)
- Review decision (approved, changes requested)
- Status conveyed by column position

#### Agent Detail View — Tabbed Drawer
- **Terminal tab:** Native terminal (SwiftTerm) — full color, Unicode, mouse, scrollback
- **History tab:** Full conversation, searchable (BM25 full-text search)
- **PR tab:** PR description, CI checks, unresolved review threads, link to browser

#### Actions Available
- Start (create worktree + launch tmux + initiate agent)
- Resume (reattach to running session)
- **Fork session** — branch conversation with shared history
- **Checkpoint** — roll back to prior conversation point
- Copy tmux attach command
- Open PR in browser
- Archive completed work

#### Key Insight
The **fork** and **checkpoint** actions are unique — they treat agent conversations as version-controllable. The embedded terminal in the detail drawer means no context-switching.

---

### 6. Claude Code Board (Web-Based)
**Source:** https://github.com/cablate/Claude-Code-Board

#### Agent List View — WebSocket-Powered Kanban
**Per-card fields:**
- Session name, project/work item, working directory
- Workflow stage (code review, debugging, feature dev)
- Associated agent (from `.claude/agents/`)
- Status: idle / processing / completed / error

Real-time Windows Toast notifications on state changes.

#### Agent Detail View — Full Conversation Chat
Clicking a card opens the full chat interface (not a panel/modal):
- Full conversation history with message type filtering (user, assistant, tool_use, thinking)
- Real-time WebSocket-powered chat
- Search within conversation
- Export as JSON

**Does NOT show:** file diffs, token counts, git info. Focus is conversation content.

#### Key Insight
Strong on workflow stage organization and agent assignment. Weak on git/diff visibility — a pure conversation-management tool.

---

### 7. ccmanager (Terminal TUI, Multi-CLI)
**Source:** https://github.com/kbwo/ccmanager
**Supports:** Claude Code, Gemini CLI, Codex CLI, Cursor Agent, Copilot CLI, Cline CLI, OpenCode, Kimi CLI

#### Agent List View — Two-Pane Menu
- Project/worktree list with numeric shortcuts (0-9)
- Session count as `[active/busy/waiting]` aggregate per project
- Status per session: **busy**, **waiting**, **idle**
- Vi-like search (`/` key)

#### Agent Detail View — IS the Terminal
No dedicated detail view. Selecting a session launches or reattaches to the live terminal.

#### Actions Available
- Create/merge/delete worktrees
- Copy session data between worktrees (preserves conversation context)
- Status change hooks for notifications
- Auto-approval mode for non-sensitive prompts

#### Key Insight
Extremely minimal by design. The **session data copy** feature (carry context to a new branch) is unique and clever. Supports 8+ CLI agents — broadest compatibility.

---

### 8. Cursor 2.0 Multi-Agent View
**Source:** https://cursor.com/changelog/2-0

#### Agent List View — Sidebar as First-Class Object
**Per-agent fields:**
- Agent task/name
- Current status as text ("Editing files", "Writing tests", "Pending")
- Model assignment (Opus-4.6, GPT 5.2, etc.)
- Progress indication

Up to 8 agents visible. Subagents shown as child entries ("Started 4 subagents" with name+status+model rows).

#### Agent Detail View — Center Pane + Review Tab
**Center pane:** Full conversation, current step/progress ("Step 3/8"), model selector dropdown.

**Review tab (separate):**
- "Pending changes" and "All changes" sections
- Split/unified diff view
- **Color-coded agreement indicators:** green = all agents agree, yellow = partial, red = divergence
- **Radio buttons** to select which agent's implementation to merge
- "Keep all" / "Undo all" bulk actions
- "Find issues" scan

**Plan Mode:** Design/iterate on requirements in background while another agent implements.

#### Actions Available
- Create/name/rename agents
- Select model per agent
- Accept/reject per-agent changes
- Compare side-by-side
- Fork to background
- Create PR from agent's work

#### Key Insight
Cursor's **multi-agent diff comparison** UI is unique in the market. Color-coded agreement across parallel implementations and per-agent merge selection is a paradigm that no other tool offers. Agents are treated as first-class IDE objects, not chat windows.

---

## CC's Current State vs. Market

### What CC Shows Now (When Expanding an Agent)

**Launcher-managed tasks:**
| Field | Useful? | Notes |
|-------|---------|-------|
| Prompt (file path) | ❌ | Shows `/var/folders/.../tmp/...` — meaningless |
| Worktree path | ⚠️ | Redundant with project name on parent row |
| Attempts (1/3) | ✅ | Useful for retry awareness |
| Session name | ⚠️ | Internal tmux identifier, not user-facing |
| Exit code | ✅ | Quick triage (0 vs non-zero) |
| PR | ✅ | PR number + review status (when applicable) |
| Ports | ⚠️ | Niche — useful for dev servers only |
| Branch | ✅ | Useful context |
| Last commit | ✅ | Best current field — shows what happened |

**Discovered agents:**
| Field | Useful? | Notes |
|-------|---------|-------|
| PID | ⚠️ | Technical, not meaningful to most users |
| Working Dir | ✅ | Helps identify the project |
| Uptime | ✅ | Duration equivalent |
| Session | ⚠️ | Internal identifier |
| Model | ✅ | Useful for multi-model setups |

### Gap Analysis

| Feature | Emdash | dmux | Nimbalyst | Superset | Kanban Code | CC Board | ccmanager | Cursor | **CC Now** | **CC Proposed** |
|---------|--------|------|-----------|----------|-------------|----------|-----------|--------|------------|-----------------|
| Prompt text visible | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
| Diff summary | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| Line counts (+/-) | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| Files changed on card | hover | ❌ | ✅ | panel | ❌ | ❌ | ❌ | panel | ❌ | ✅ |
| Kill/stop | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ |
| View output/terminal | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| View diffs | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| Retry/restart | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | P1 |
| Agent type badge | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | P1 |
| CI/CD integration | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | P2 |
| PR management | ✅ | merge | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | partial | P1 |
| Token/cost | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | P2 |
| Issue integration | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | P2 |
| Merge from sidebar | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | P2 |
| Multi-agent compare | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | P3 |
| Auto-discovery | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **✅** | ✅ |
| Mobile companion | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | P3 |

---

## Recommended Feature Set (Prioritized)

### P0 — Must Have (Parity with Market)

1. **Prompt text display** — Read the temp file and show first ~80 chars of actual prompt. Tooltip shows full text. Every competitor does this.

2. **Diff summary** — `N files changed · +X / -Y` computed from `git diff --stat` on the agent's worktree. This is the #1 most requested "what happened" signal.

3. **Lifecycle controls** — Kill/stop button as inline action. Read-only dashboards lose to tools with controls. Context menu minimum: Kill, Open Terminal, View Diff.

4. **View output action** — Button to focus/open the agent's terminal (tmux session) in VS Code's integrated terminal.

### P1 — Should Have (Competitive Positioning)

5. **Agent type badge** — Icon per CLI (Claude 🟣, Codex 🟢, Gemini 🔵, Cursor 🟡) replacing generic status icons.

6. **3-color status system** — Adopt Superset's pattern: amber = working, red = needs attention, green = ready for review. Clearest encoding across all tools studied.

7. **File change list** — Per-file diff stats as expandable children (or on hover). Nimbalyst shows this on the card; Emdash shows on hover.

8. **View diff action** — Open VS Code's native diff viewer for the agent's worktree changes against its base branch.

9. **Retry/restart action** — Re-run the same prompt in a fresh worktree. 5 of 8 tools support this.

10. **PR creation/management** — Create PR from sidebar, show PR status and review state.

### P2 — Nice to Have (Differentiation)

11. **Token/cost tracking** — **No competitor shows this.** First-mover opportunity. Display input/output tokens and estimated cost per session.

12. **Status timeline** — State transitions with timestamps (created → running → waiting → completed). Useful for debugging "what happened when."

13. **Issue integration** — Link to GitHub Issues / Linear tickets. Emdash and Superset pull tasks directly from issue trackers.

14. **Merge action** — One-click merge from sidebar (with confirmation). dmux's one-key merge is beloved.

15. **CI check status** — Inline pass/fail indicators per agent's branch/PR.

### P3 — Future (Post-Launch)

16. **Multi-agent comparison** — Cursor's paradigm of comparing parallel agent outputs with color-coded agreement.

17. **Session fork/checkpoint** — Kanban Code's ability to branch conversations and roll back.

18. **Mobile companion** — Push notifications when agents need input (Nimbalyst's iOS pattern).

19. **Conversation search** — Full-text search across agent conversations (Kanban Code's BM25 search).

---

## Proposed Agent Detail View — Mockup

### Expanded Tree Item (Redesigned)

```
▼ 🟢 session-persist · Command Central · 12m
  📝 "Add session persistence layer with click-to-focus"
  📊 4 files · +340 / -87
  🔀 feat/session-persist → 4a29f2a "add persistence service"
  ⏱ 12m 34s · Exit 0 · Attempt 1/3
  ── Actions ──────────────────────────────────
  ▶ View Output  |  📄 View Diff  |  ⏹ Kill
```

### Compact Mode (Collapsed)

```
▶ 🟢 session-persist · 4 files +340/-87 · 12m
```

### Field Breakdown

| Row | Content | Source | Why |
|-----|---------|--------|-----|
| **1. Header** | Status color + name + project + duration | task config | Scannable at a glance |
| **2. Prompt** | First 80 chars of actual task text | Read temp file | Answers "what is this doing?" |
| **3. Diff summary** | Files changed + lines added/removed | `git diff --stat` on worktree | Answers "how much changed?" |
| **4. Git context** | Branch → short hash + subject | `git log -1` on worktree | Answers "where are changes?" |
| **5. Metadata** | Duration + exit code + attempt count | task state | Triage information |
| **6. Actions** | View Output, View Diff, Kill | commands | Answers "what should I do?" |

### Information Architecture Changes vs. Current

| Change | Rationale |
|--------|-----------|
| **Remove** worktree path | Redundant with project name on parent row |
| **Remove** session name | Internal tmux identifier, not user-facing value |
| **Replace** prompt file path → prompt text | Core usability fix — file paths are meaningless |
| **Add** diff summary | #1 most valuable field missing from CC |
| **Add** action buttons | Every competitor has lifecycle controls |
| **Consolidate** branch + last commit → one line | Reduce vertical space, increase density |
| **Consolidate** duration + exit code + attempts → one line | Three low-priority fields compressed |
| **Move to tooltip** | Full prompt text, full commit message, worktree path, PID |

### Discovered Agents (Redesigned)

```
▼ 🔵 my-project (discovered) · 45m
  🔍 PID 12345 · via session file
  📊 2 files · +28 / -4
  🔀 main → a1b2c3d "fix validation logic"
  ── Actions ──────────────────────────────────
  ▶ Open Terminal  |  📄 View Diff
```

---

## CC's Unique Advantages to Preserve and Amplify

1. **Auto-discovery** — No competitor discovers running agents from external terminals inside VS Code. This is CC's moat. The sidebar redesign makes this advantage more valuable by giving discovered agents the same rich detail view as managed agents.

2. **VS Code native** — Unlike Emdash (Electron app), Nimbalyst (native app), Superset (standalone IDE), and dmux (terminal), CC lives where developers already work. Lower friction = higher adoption.

3. **Multi-CLI agnostic** — Like ccmanager but with a GUI. CC can show Claude, Codex, Gemini agents side by side with a unified UX.

4. **Token/cost tracking opportunity** — Zero competitors show this. CC could be the first tool to answer "how much did this agent cost?" — a question every team lead asks.

---

## Appendix: Research Sources

| Tool | Type | GitHub | Key Source |
|------|------|--------|------------|
| Emdash | Electron app | generalaction/emdash | docs.emdash.sh, changelog |
| dmux | Terminal TUI | standardagents/dmux | dmux.ai, README |
| Nimbalyst | Native desktop + iOS | Nimbalyst/nimbalyst | nimbalyst.com/features |
| Superset | Desktop IDE | superset-sh/superset | superset.sh/changelog, docs |
| Kanban Code | Native macOS | langwatch/kanban-code | GitHub README |
| Claude Code Board | Web UI | cablate/Claude-Code-Board | GitHub README |
| ccmanager | Terminal TUI | kbwo/ccmanager | GitHub README |
| Cursor 2.0 | IDE built-in | N/A (proprietary) | cursor.com/changelog/2-0 |
