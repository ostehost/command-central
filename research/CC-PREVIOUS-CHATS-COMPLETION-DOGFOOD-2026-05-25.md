# CC Previous Chats + Completion Routing — Dogfood Report

**Task:** `cc-prev-chats-completion-20260525-2055`
**Date:** 2026-05-25
**Commit:** 3ad35631 on main

## Summary

Made the extension materially better at two observable problems:

1. **Previous chats / transcripts** now surface the exact Claude session UUID in action labels so users can see at a glance whether clicking "Open Prior Chat" or "Resume" targets the specific conversation vs. a project-scoped fallback.

2. **Completion routing** is now classified and visible — tasks show whether they are **owner-bound** (session_key or callback_url present → completion auto-reported) or **detached** (neither present → manual observation required).

## What Changed

### 1. Completion Routing Classification (`agent-status-tree-provider.ts`)

- Added `session_key` to `AgentTask` interface and JSON parsing
- New exported `classifyCompletionRouting()` function with three states:
  - `owner-bound` — has session_key and/or callback_url
  - `detached` — neither present, completion was not auto-reported
  - `not-applicable` — used when classification doesn't make sense
- Routing detail appears as section 7 in expanded task children (after ports)
- Routing info added to task tooltip markdown
- Completed detached tasks show `⚠ detached` in the description line

### 2. Redesigned Dead-Session QuickPick (`extension.ts`)

The QuickPick shown when clicking a completed/dead task was redesigned:

**Before:**
1. Open/Build Ghostty Terminal
2. Resume in Interactive Mode
3. View Session Transcript
4. View Diff

**After:**
1. **Open Prior Chat** (with UUID short prefix if available, exact/best-match label)
2. **Resume Exact Session** (with UUID, shows full `claude --resume` command) or Resume in Interactive Mode
3. Focus/Build Project Terminal
4. View Diff
5. Show Output
6. Routing health info line (owner-bound or detached)

Key improvements:
- Transcript and resume are primary (top) instead of terminal focus
- Claude session UUID shown in labels so it's unambiguous which conversation opens
- "Exact session transcript" vs "Best-match transcript" clearly labeled
- Resume shows the actual command (`claude --resume <uuid>` vs `claude --continue`)
- Routing health info at bottom shows if completion was reported or needs manual observation
- QuickPick placeholder includes detached warning for manual-observation tasks

### 3. Resume Session QuickPick (`extension.ts`)

Same principles applied to the resume command's QuickPick:
- Prior chat listed first with UUID
- Resume with exact session targeting
- Terminal focus/build demoted below primary actions
- Routing health info appended

### 4. Right-Click Quick Actions (`agent-quick-actions.ts`)

- Added `viewTranscript` / "Open Prior Chat" as first action for all terminal task statuses
- Action ordering now: Open Prior Chat → (Resume Session) → View Diff → Show Output → Focus Terminal → ...

## Files Changed

| File | Lines | Description |
|------|-------|-------------|
| `src/providers/agent-status-tree-provider.ts` | +100 | session_key parsing, classifyCompletionRouting, detail/tooltip/description routing |
| `src/extension.ts` | +172/-66 | Redesigned dead-session + resume QuickPick menus |
| `src/commands/agent-quick-actions.ts` | +37/-5 | Added viewTranscript, reordered action lists |
| `test/commands/agent-quick-actions-options.test.ts` | +35/-13 | Updated expected action labels |
| `test/tree-view/agent-status-tree-provider-discovery.test.ts` | +4/-3 | Updated detail child counts |
| `test/tree-view/agent-status-tree-provider-pure-helpers.test.ts` | +100 | 10 new tests for classifyCompletionRouting |

## Test Results

```
$ just test
1582 pass, 0 fail, 1 skip (1583 total across 119 files, 13.20s)

$ just check
Checked 242 files. No issues.

$ bunx tsc --noEmit
No errors.
```

### Targeted test commands:
```bash
bun test test/tree-view/agent-status-tree-provider-pure-helpers.test.ts  # routing classifier (10 new tests)
bun test test/commands/agent-quick-actions-options.test.ts                # action menu structure
bun test test/tree-view/agent-status-tree-provider-rendering.test.ts     # tree rendering
bun test test/tree-view/agent-status-tree-provider-discovery.test.ts     # detail children
bun test test/commands/resume-session.test.ts                            # resume session logic
```

## Git State

```
HEAD: 3ad35631 on main
Tree: clean (no untracked, no modified)
Ahead of origin: yes (local-only, not pushed per constraints)
```

## Manual Verification Steps

### Previous Chat Surfacing

1. Open VS Code with Command Central extension loaded
2. In Agent Status tree, click a **completed** task that has `claude_session_id` recorded
3. The QuickPick should show:
   - "Open Prior Chat (xxxxxxxx…)" as the first item with "Exact session transcript" description
   - "Resume Exact Session (xxxxxxxx…)" with the `claude --resume <uuid>` command
4. For tasks **without** `claude_session_id`, the same actions should show without UUID suffix and say "Best-match transcript" / "claude --continue (project-scoped...)"

### Owner-Bound vs Detached Completion

1. Expand a completed task in Agent Status
2. At the bottom of the detail list, a routing health line should show:
   - **Owner-bound completion** with radio-tower icon (green) for tasks with `session_key` or `callback_url`
   - **Detached — manual observation required** with disconnect icon (yellow) for tasks without either
3. Hover over the task — tooltip should include a **Routing** line
4. The description line for completed detached tasks should include `⚠ detached`

### Dogfood validation with real tasks

- `cc-dogfood-agent-status-20260525-2008`: `session_key: null`, `callback_url: null` → should show **detached** with yellow warning
- `cc-release-preview-update-20260525-2036`: `session_key: agent:main:dashboard:fff3d5cc...`, `callback_url: https://gateway.partnerai.dev/hooks/agent` → should show **owner-bound** with green routing

## Boundary: What CC Cannot Fix

Completion event delivery is a **launcher responsibility**. When a task is launched detached (no `session_key`, no `callback_url`), the launcher did not wire up the return path. Command Central cannot retroactively deliver completion events — it can only **surface the truth clearly** so the user knows to manually observe.

Specific launcher-side follow-ups:
- Ensure `session_key` is always propagated from the orchestrator session to the launcher task entry at spawn time
- Ensure `callback_url` is set when autonomous completion reporting is expected
- Consider a launcher-side guard that warns at spawn-time if a task is being launched without routing fields when the orchestration mode expects them
