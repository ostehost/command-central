## Uncovered Items
- `oste-stop-hook.sh` does not forward `last_assistant_message`; it currently logs progress turns only.
- Pending-review JSON does not include `agent_summary` or `transcript_path`.
- Wake payload remains free-form text, not structured `TASK_COMPLETE task_id=...`.
- `SessionEnd` safety-net hook is not configured in `~/.claude/settings.json`.

# Research: Orchestration Completion Chain Best Practices

> **Date:** 2026-03-21
> **Task ID:** research-orchestration-chain
> **Status:** Complete

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Claude Code Agent Teams](#1-claude-code-agent-teams)
3. [Claude Code Hooks Deep Dive](#2-claude-code-hooks-deep-dive)
4. [Community Patterns](#3-community-patterns)
5. [Technical Questions Answered](#4-technical-questions-answered)
6. [Recommended Architecture](#5-recommended-architecture)
7. [Specific Code Changes](#6-specific-code-changes)
8. [Completion Report Template](#7-completion-report-template)

---

## Executive Summary

The existing Oste orchestration chain (spawn → stop-hook → complete → notify → wake) is **architecturally sound** and already implements most best practices seen in the community. The main gaps are:

1. **The Stop hook's `last_assistant_message` is not being forwarded** through the completion chain — this is the single highest-value improvement.
2. **OpenClaw `/hooks/wake` supports structured text** — the wake payload can carry task completion summaries.
3. **The pending-review file can include the agent's final message** — giving Oste a rich completion report without needing to read transcripts.
4. **Agent Teams are a parallel option** but don't replace the current architecture for Ghostty-visible terminal orchestration.

---

## 1. Claude Code Agent Teams

### Source
- Official docs: https://code.claude.com/docs/en/agent-teams
- Requires Claude Code v2.1.32+ (released 2026-02-05), experimental flag `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`

### Coordination Mechanisms

| Component     | Description |
|---------------|-------------|
| **Task List** | Shared JSON files at `~/.claude/tasks/{team-name}/N.json`. States: pending → in_progress → completed. Supports dependency blocking (auto-unblocks when blocker completes). File-locked claiming prevents races. |
| **Mailbox**   | JSON inbox files at `~/.claude/teams/{name}/inboxes/{agent}.json`. Push-based: messages delivered automatically. Supports `write` (targeted) and `broadcast` (all teammates). |
| **Idle Notifications** | When a teammate finishes and stops, it automatically notifies the lead. |
| **Team Config** | `~/.claude/teams/{team-name}/config.json` with `members` array (name, agent_id, agent_type). |

### Can the Lead Be an External Orchestrator?

**No — the lead must be a Claude Code session.** The lead is "the main Claude Code session that creates the team." Leadership is fixed at creation and cannot be transferred. However:

- An external orchestrator (OpenClaw) can **instruct** the lead via its terminal input
- The lead can be run in `--dangerously-skip-permissions` mode for autonomous operation
- Teammates inherit the lead's permission settings

**Implication for Oste:** Agent Teams provide *intra-Claude* coordination but don't replace the need for an external spawn/complete/wake chain. The two systems are complementary — Agent Teams for multi-agent collaboration within a task, Oste for lifecycle management across tasks.

### Relevant Hooks That Fire During Team Operation

| Hook | When | JSON Input | Control |
|------|------|------------|---------|
| `TeammateIdle` | Teammate about to go idle | `{teammate_name, team_name, session_id, cwd}` | Exit 2 + stderr → feedback, keeps teammate working |
| `TaskCompleted` | Task marked complete | `{task_id, task_subject, task_description, teammate_name, team_name}` | Exit 2 + stderr → blocks completion with feedback |
| `SubagentStart` | Subagent spawned | `{agent_id, agent_type}` | `additionalContext` injected into subagent |
| `SubagentStop` | Subagent finishes | `{agent_id, agent_type, agent_transcript_path, last_assistant_message}` | `decision: "block"` prevents stopping |

### tmux Split-Pane Mode

- **Display modes:** `in-process` (default, all in one terminal) or `tmux`/`auto` (split panes)
- **`auto` mode:** Uses split panes if already inside tmux, else in-process
- **Navigation:** `Shift+Down` cycles teammates, `Ctrl+T` toggles task list
- **Limitation:** Split panes are NOT supported in Ghostty (only tmux sessions and iTerm2)
- **Setting:** `"teammateMode": "tmux"` in settings.json or `--teammate-mode tmux` CLI flag

**Implication for Oste:** Since Ghostty doesn't support Agent Teams split panes, the current pattern of spawning independent Claude Code sessions in separate Ghostty tabs/windows remains the right approach. Agent Teams would need tmux wrapping inside Ghostty, adding complexity.

---

## 2. Claude Code Hooks Deep Dive

### Source
- Official docs: https://code.claude.com/docs/en/hooks

### Complete Hook Event Catalog

Claude Code supports **20 hook events** across 4 handler types (command, http, prompt, agent):

| Event | Fires When | Blockable | Key Fields |
|-------|-----------|-----------|------------|
| `SessionStart` | New session, resume, clear, compact | No | `source`, `model`, `agent_type` |
| `UserPromptSubmit` | User submits prompt | Yes | `prompt`, `permission_mode` |
| `PreToolUse` | Before tool execution | Yes | `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequest` | Permission dialog about to show | Yes | `tool_name`, `permission_suggestions` |
| `PostToolUse` | Tool completes successfully | Yes | `tool_name`, `tool_input`, `tool_response` |
| `PostToolUseFailure` | Tool execution fails | No | `tool_name`, `error`, `is_interrupt` |
| `Notification` | Desktop notification sent | No | `message`, `title`, `notification_type` |
| `SubagentStart` | Subagent spawned | No | `agent_id`, `agent_type` |
| `SubagentStop` | Subagent finishes | Yes | `agent_id`, `last_assistant_message`, `agent_transcript_path` |
| **`Stop`** | **Main agent finishes responding** | **Yes** | **`last_assistant_message`, `stop_hook_active`** |
| `StopFailure` | Turn ends due to API error | No | `error`, `error_details` |
| **`TeammateIdle`** | **Teammate about to idle** | **Yes (exit 2)** | **`teammate_name`, `team_name`** |
| **`TaskCompleted`** | **Task marked complete** | **Yes (exit 2)** | **`task_id`, `task_subject`, `task_description`** |
| `SessionEnd` | Session terminates | No | `reason` (clear/resume/logout/prompt_input_exit/other) |
| `InstructionsLoaded` | CLAUDE.md loaded | No | `file_path`, `memory_type`, `load_reason` |
| `ConfigChange` | Settings file changes | Yes | `source`, `file_path` |
| `WorktreeCreate` | Git worktree created | Yes | `name` (must print worktree path) |
| `WorktreeRemove` | Git worktree removed | No | `worktree_path` |
| `PreCompact` / `PostCompact` | Before/after compaction | No | `trigger`, `compact_summary` (post) |

### Stop Hook — Full JSON Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../transcript.jsonl",
  "cwd": "/working/directory",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": true,
  "last_assistant_message": "I've completed the refactoring. Here's a summary..."
}
```

**Key insight:** `last_assistant_message` contains the agent's **full final response text**. This is the completion summary.

**`stop_hook_active`:** Boolean — `true` when the stop hook itself triggered this turn (prevents infinite loops). The existing `oste-stop-hook.sh` correctly guards on this.

### Can Stop Hook Extract the Final Summary?

**Yes, absolutely.** The `last_assistant_message` field contains the agent's complete final response. Current `oste-stop-hook.sh` receives this via stdin JSON but **does not forward it** to `oste-complete.sh`. This is the #1 gap.

### TaskCompleted Hook — Full JSON Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/directory",
  "permission_mode": "default",
  "hook_event_name": "TaskCompleted",
  "task_id": "task-001",
  "task_subject": "Implement user authentication",
  "task_description": "Add login and signup endpoints",
  "teammate_name": "implementer",
  "team_name": "my-project"
}
```

**Note:** This fires for Agent Teams tasks, not for the external Oste task system. It's useful for bridging Agent Teams completions into the Oste notification chain (which `oste-task-completed-hook.sh` already does).

### SessionEnd Hook — For Final Cleanup

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/directory",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

**Timeout:** Default 1.5s, configurable via `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`.

**Use case:** Final cleanup/notification as a safety net. However, the short timeout (1.5s) makes it unsuitable for complex completion chains. The Stop hook (no timeout constraint) is better for the primary completion path.

### Exit Code Semantics

| Exit Code | Meaning | Effect |
|-----------|---------|--------|
| **0** | Success | Parse JSON stdout, continue |
| **2** | Blocking error | Feed stderr to Claude, block action |
| **Other** | Non-blocking error | Log stderr, continue |

### HTTP Hooks (Alternative to Command Hooks)

Hooks can be HTTP endpoints instead of shell scripts:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "http",
        "url": "http://localhost:8080/hooks/stop",
        "timeout": 30,
        "headers": { "Authorization": "Bearer $TOKEN" }
      }]
    }]
  }
}
```

**Implication:** Could POST directly to OpenClaw's `/hooks/wake` from a Claude Code HTTP hook, eliminating the shell script intermediary. However, the current shell approach is more debuggable and supports the multi-step completion logic.

---

## 3. Community Patterns

### dmux (StandardAgents)

**Source:** https://github.com/standardagents/dmux

| Feature | Details |
|---------|---------|
| **Model** | One tmux pane per task, each with its own git worktree + branch |
| **Agents** | Supports Claude Code, Codex, Gemini CLI, OpenCode, and 8+ others |
| **Lifecycle hooks** | `worktree create`, `pre-merge`, `post-merge`, and more (stored in `.dmux-hooks/`) |
| **Completion** | Background panes send native attention alerts (macOS notifications) when they settle |
| **Merging** | Manual via pane menu — auto-commit, merge, cleanup in one step |

**Key difference from Oste:** dmux is interactive-first (user drives merging), while Oste is automation-first (completion triggers a chain). dmux doesn't have an external orchestrator wake mechanism.

### cmux

**Source:** https://cmux.com/, https://github.com/craigsc/cmux

| Feature | Details |
|---------|---------|
| **Model** | Native macOS terminal (Swift/AppKit), not tmux-based |
| **Hook system** | Scripts triggered by agent events (session start, task complete) |
| **Notifications** | Terminal escape sequences (OSC 9/99/777) or cmux CLI |
| **MCP layer** | `cmuxlayer` MCP server with `spawn_agent`, `stop_agent`, `send_input`, `read_screen` tools |
| **Orchestration** | Primary agent delegates to sub-agents in different panes via MCP |

**Key insight:** cmuxlayer's MCP approach (spawn_agent/stop_agent) is interesting but requires an MCP-capable orchestrator. OpenClaw doesn't currently support MCP tool calls from hooks.

### Claude Code Multi-Agent Orchestration Gist

**Source:** https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea

Documents the pull-based task system + push-based inbox messaging pattern:
- Workers poll `TaskList()`, claim pending tasks, complete work
- Idle notifications auto-sent: `{"type": "idle_notification", "completedTaskId": "2", "completedStatus": "completed"}`
- Shutdown is a request/approve handshake
- "Self-organizing swarm" pattern: workers race to claim tasks, naturally load-balance

### AMUX / ruflo / wshobson/agents

Other community orchestrators exist but are less mature or use different paradigms:
- **AMUX:** Web dashboard for live terminal monitoring, self-healing watchdog
- **ruflo:** Enterprise swarm platform, distributed architecture
- **wshobson/agents:** Multi-agent orchestration with custom coordination

None provide a better completion callback pattern than what Oste already implements.

---

## 4. Technical Questions Answered

### Q1: Can `oste-stop-hook.sh` extract the agent's final message from stdin JSON?

**Yes.** The Stop hook receives `last_assistant_message` in its stdin JSON. Current implementation reads the JSON but only extracts `session_id`, `transcript_path`, `stop_hook_active`, and `cwd`. Adding extraction of `last_assistant_message` is straightforward:

```bash
last_message=$(echo "$input_json" | jq -r '.last_assistant_message // empty')
```

This can then be:
1. Passed to `oste-complete.sh` as an argument or env var
2. Written to a temp file (`/tmp/oste-last-message-${task_id}`)
3. Included in the pending-review JSON

**Caveat:** `last_assistant_message` can be very large (multi-KB). Truncation to ~500 chars for the wake payload is recommended. The full message can go in the pending-review file.

### Q2: Can we use `openclaw system event --text "TASK_COMPLETE:task-id:summary" --mode now`?

**Yes, and this is already being done.** The existing `oste-notify.sh` uses this as Layer 2 fallback:

```bash
openclaw system event --text "$event_text" --mode now
```

The `/hooks/wake` HTTP endpoint (Layer 1) accepts the same payload structure:

```json
{ "text": "TASK_COMPLETE:my-task-id:Implemented feature X", "mode": "now" }
```

**Recommendation:** Structure the text as a parseable format so Oste's heartbeat can extract task_id and summary:

```
TASK_COMPLETE task_id=my-task summary="One-line description" status=success
```

### Q3: Is there a way to `sessions_send` from a shell script to the main OpenClaw session?

**Not directly via documented API.** The relevant GitHub issue (openclaw/openclaw#42621) requests exactly this — delivering webhook events to an existing agent session instead of spawning isolated runs. As of 2026-03-21, this is still an open feature request.

**Current workarounds:**
1. **`/hooks/wake`** — Enqueues a system event for the main session (this IS what Oste uses)
2. **`/hooks/agent`** — Runs an isolated agent turn that posts a summary back to main session
3. **Cron wake** — `openclaw cron run <cron-id>` triggers the heartbeat cron which wakes the main session

**The `/hooks/wake` endpoint IS effectively `sessions_send` for the main session.** The text becomes a system event that the main agent sees on its next turn.

### Q4: Can the pending-review file include the agent's completion report?

**Yes, and this is already partially implemented.** The `pending-review.sh` library supports a `report` field that contains the `.oste-report.yaml` payload:

```json
{
  "task_id": "my-task",
  "status": "completed",
  "report": {
    "task_id": "my-task",
    "status": "success",
    "summary": "Implemented feature X",
    "files_changed": ["src/foo.ts"],
    "tests_passing": true
  }
}
```

**Gap:** The `last_assistant_message` from the Stop hook is NOT included. Adding it (truncated) to the pending-review would give Oste the agent's own completion narrative in addition to the structured report.

---

## 5. Recommended Architecture

### Current Flow (Working)

```
oste-spawn.sh
  → Ghostty terminal + Claude Code
    → Agent works on task
      → Agent runs `oste-done.sh` (signals completion)
      → Claude Code Stop hook fires
        → oste-stop-hook.sh (maps CWD→task_id)
          → oste-complete.sh (background)
            → Auto-commit uncommitted changes
            → Update tasks.json
            → Write pending-review file
            → Ingest .oste-report.yaml
            → oste-notify.sh
              → Layer 1: POST /hooks/wake (11ms)
              → Layer 2: openclaw system event (2.4s fallback)
              → Layer 3: Discord notification
            → OpenClaw heartbeat wakes Oste
              → Oste reads pending-review files
              → Reviews completed work
```

### Recommended Improvements

```
CHANGE 1: Forward last_assistant_message through the chain
─────────────────────────────────────────────────────────
oste-stop-hook.sh
  ├── Extract last_assistant_message from stdin JSON
  ├── Truncate to 500 chars → $OSTE_LAST_MESSAGE
  └── Pass to oste-complete.sh via env var or temp file

CHANGE 2: Enrich pending-review with agent's final message
───────────────────────────────────────────────────────────
oste-complete.sh
  ├── Read $OSTE_LAST_MESSAGE (from stop hook) or /tmp/oste-last-message-${task_id}
  ├── Read .oste-report.yaml (from agent's structured report)
  └── Write to pending-review:
      {
        "task_id": "...",
        "status": "completed",
        "report": { /* .oste-report.yaml */ },
        "agent_summary": "First 500 chars of last_assistant_message",
        "last_commit": "abc1234"
      }

CHANGE 3: Structured wake payload
──────────────────────────────────
oste-notify.sh
  ├── Wake text format:
  │   "TASK_COMPLETE task_id=X status=Y summary=Z"
  └── Oste's heartbeat cron parses this to know WHAT completed

CHANGE 4: SessionEnd as safety net
───────────────────────────────────
settings.json hooks:
  SessionEnd → oste-session-end-hook.sh
    ├── Check if oste-complete already ran (idempotency marker)
    ├── If not: fire oste-complete.sh as emergency fallback
    └── Timeout budget: 1.5s (tight — keep it simple)

CHANGE 5: HTTP hook as alternative to shell (optional, future)
──────────────────────────────────────────────────────────────
Instead of: Stop → shell script → curl /hooks/wake
Consider:   Stop → HTTP hook → direct POST to /hooks/wake
  ├── Eliminates shell process overhead
  ├── Built-in timeout handling
  └── But: loses the multi-step completion logic
  → Verdict: Keep shell for now. HTTP hook is a simplification
    for when the chain is proven stable.
```

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw (Oste)                       │
│                                                         │
│  Heartbeat Cron ←──── /hooks/wake ←─── oste-notify.sh  │
│       │                                      ↑          │
│       ▼                                      │          │
│  Read pending-review/   ←── oste-complete.sh ┘          │
│       │                        ↑                        │
│       ▼                        │                        │
│  Review & act on            Stop hook                   │
│  completed tasks        (last_assistant_message)        │
│                                ↑                        │
└────────────────────────────────│────────────────────────┘
                                 │
┌────────────────────────────────│────────────────────────┐
│              Ghostty Terminal  │                         │
│                                │                        │
│  Claude Code agent ──► Stop ───┘                        │
│       │                                                 │
│       ├── .oste-report.yaml (structured)                │
│       └── oste-done.sh (interactive signal)             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Why NOT Use Agent Teams Instead?

| Aspect | Agent Teams | Current Oste Pattern |
|--------|------------|---------------------|
| **Visibility** | tmux panes (no Ghostty support) | Native Ghostty tabs with role theming |
| **Lead** | Must be Claude Code session | OpenClaw (external, persistent) |
| **Persistence** | Lost on session end | tasks.json + pending-review survive crashes |
| **Multi-backend** | Claude Code only | Claude, Gemini, Codex, ACP variants |
| **Token cost** | Higher (shared context) | Lower (isolated sessions) |
| **Completion chain** | Internal mailbox only | Shell → webhook → OpenClaw (auditable) |

**Verdict:** Agent Teams are valuable *within* a single complex task (e.g., parallel code review). The Oste pattern is better for *across-task* orchestration with an external coordinator. They can coexist — an Oste-spawned agent could itself spawn an Agent Team for subtasks.

---

## 6. Specific Code Changes Needed

### Change 1: `oste-stop-hook.sh` — Extract and forward `last_assistant_message`

**File:** `ghostty-launcher/scripts/lib/oste-stop-hook.sh`
**What:** After reading stdin JSON, extract `last_assistant_message`, truncate to 500 chars, write to `/tmp/oste-last-message-${task_id}`.
**Why:** This is the richest signal of what the agent actually accomplished.

```bash
# After existing jq extractions:
last_message=$(echo "$input_json" | jq -r '.last_assistant_message // empty' | head -c 500)
if [[ -n "$last_message" && -n "$task_id" ]]; then
  echo "$last_message" > "/tmp/oste-last-message-${task_id}"
fi
```

### Change 2: `oste-complete.sh` — Include agent summary in pending-review

**File:** `ghostty-launcher/scripts/oste-complete.sh`
**What:** Read `/tmp/oste-last-message-${task_id}` and include as `agent_summary` field in pending-review JSON.
**Why:** Gives Oste immediate context about what was accomplished without reading git diffs.

```bash
# In the pending-review write step:
agent_summary=""
if [[ -f "/tmp/oste-last-message-${task_id}" ]]; then
  agent_summary=$(cat "/tmp/oste-last-message-${task_id}")
  rm -f "/tmp/oste-last-message-${task_id}"
fi
# Pass to pending_review_write as additional field
```

### Change 3: `oste-notify.sh` — Structured wake text

**File:** `ghostty-launcher/scripts/oste-notify.sh`
**What:** Change wake text from free-form to structured format.
**Why:** Allows Oste's heartbeat handler to parse task_id and status programmatically.

```bash
# Current:
wake_text="Task ${task_id} completed in ${project}"

# Proposed:
wake_text="TASK_COMPLETE task_id=${task_id} project=${project} status=${status}"
```

### Change 4: `settings.json` — Add SessionEnd safety net hook

**File:** `~/.claude/settings.json`
**What:** Add SessionEnd hook that fires `oste-complete.sh` if the Stop hook didn't.
**Why:** Catches edge cases where the process exits without a clean Stop (crash, timeout, force-quit).

```json
{
  "hooks": {
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "bash /path/to/oste-session-end-hook.sh"
      }]
    }]
  }
}
```

**Constraint:** 1.5s timeout — the hook must be fast. Check idempotency marker, fire `oste-complete.sh` in background if not already run.

### Change 5: Pending-review schema extension

**Current:**
```json
{
  "task_id": "string",
  "status": "string",
  "report": {}
}
```

**Proposed addition:**
```json
{
  "agent_summary": "First 500 chars of last_assistant_message (from Stop hook)",
  "transcript_path": "Path to full transcript JSONL for deep review"
}
```

---

## 7. Completion Report Template

### Agent-side (`.oste-report.yaml`)

```yaml
# Written by the agent before signaling completion
task_id: "{{TASK_ID}}"
status: "success|failure"
summary: "One-line summary of work done"
files_changed:
  - "path/to/file1"
  - "path/to/file2"
tests_passing: true|false
next_steps: "Optional recommendation for the next task"
```

### Pending-review (enriched by completion chain)

```json
{
  "task_id": "my-task-id",
  "project": "command-central",
  "project_path": "/Users/ostemini/projects/command-central",
  "status": "completed",
  "exit_code": 0,
  "completed_at": "2026-03-21T14:30:00Z",
  "last_commit": "abc1234def",
  "reviewed": false,
  "reported_to_user": false,
  "report": {
    "task_id": "my-task-id",
    "status": "success",
    "summary": "Implemented feature X with tests",
    "files_changed": ["src/foo.ts", "src/test/foo.test.ts"],
    "tests_passing": true,
    "next_steps": "Consider adding integration tests"
  },
  "agent_summary": "I've completed the implementation of feature X. The main changes were...",
  "transcript_path": "~/.claude/projects/.../transcript.jsonl"
}
```

### Wake payload (structured)

```
TASK_COMPLETE task_id=my-task-id project=command-central status=completed summary="Implemented feature X with tests"
```

---

## Appendix: Sources

- [Claude Code Agent Teams docs](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Hooks docs](https://code.claude.com/docs/en/hooks)
- [dmux — StandardAgents](https://github.com/standardagents/dmux)
- [cmux terminal](https://cmux.com/)
- [Claude Code Swarm Orchestration Gist](https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea)
- [OpenClaw Hooks docs](https://docs.openclaw.ai/automation/hooks)
- [OpenClaw Webhook docs](https://docs.openclaw.ai/automation/webhook)
- [OpenClaw issue #42621 — Webhook to existing session](https://github.com/openclaw/openclaw/issues/42621)
- [Shipyard — Multi-agent orchestration blog](https://shipyard.build/blog/claude-code-multi-agent/)
- [Addy Osmani — Claude Code Swarms](https://addyosmani.com/blog/claude-code-agent-teams/)
