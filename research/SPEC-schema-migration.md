CLEAR
# SPEC: tasks.json Schema Migration (v1 → v2)

> Migrate the agent status tree provider from tasks.json v1 to v2 schema,
> renaming `tmux_session` to `session_id` with backward compatibility.

**Status:** Draft
**Date:** 2026-03-08

---

## 1. Motivation

The Ghostty launcher now writes tasks.json with `session_id` instead of
`tmux_session`. The field was renamed because the session identifier is no
longer tmux-specific — it can refer to a tmux session, an AppleScript-managed
terminal, or a Ghostty bundle. The tree provider, command handlers, and tests
must be updated to prefer the new field while still reading v1 files.

---

## 2. Schema Diff

### v1 (current)

```jsonc
{
  "version": 1,
  "tasks": {
    "task-abc": {
      "id": "task-abc",
      "status": "running",
      "tmux_session": "agent-my-app",   // <-- v1 field
      // ... other fields unchanged
    }
  }
}
```

### v2 (target)

```jsonc
{
  "version": 2,
  "tasks": {
    "task-abc": {
      "id": "task-abc",
      "status": "running",
      "session_id": "agent-my-app",     // <-- replaces tmux_session
      // ... other fields unchanged
    }
  }
}
```

### AgentTask interface change

```typescript
// BEFORE (v1 only)
export interface AgentTask {
  // ...
  tmux_session: string;
  // ...
}

// AFTER (v2 primary, v1 compat)
export interface AgentTask {
  // ...
  session_id: string;          // v2 primary field
  tmux_session?: string;       // v1 compat — optional, read-only fallback
  // ...
}
```

The canonical field is `session_id`. When reading a v1 registry, the
`normalizeTask()` function copies `tmux_session` into `session_id` so all
downstream code only reads `session_id`.

---

## 3. Files to Modify

### 3.1 `src/providers/agent-status-tree-provider.ts`

| Area | Change |
|------|--------|
| `AgentTask` interface | Add `session_id: string`. Change `tmux_session` to `tmux_session?: string` (optional). |
| `isValidTmuxSession()` | Rename to `isValidSessionId()`. Keep old name as deprecated re-export. |
| `readRegistry()` | Accept `parsed.version === 1 \|\| parsed.version === 2`. Call `normalizeTask()` on each task. |
| `normalizeTask()` | New helper. If `session_id` is missing but `tmux_session` is present, set `session_id = tmux_session`. |
| `getChildren()` detail node | Change label from `"tmux"` to `"Session"` and value from `t.tmux_session` to `t.session_id`. |
| Default empty registry | Change `{ version: 1, tasks: {} }` to `{ version: 2, tasks: {} }`. |

### 3.2 `src/extension.ts`

| Area | Change |
|------|--------|
| Import | Change `isValidTmuxSession` to `isValidSessionId`. |
| `captureAgentOutput` command | Change `tmux_session` to `session_id` everywhere. |
| `killAgent` command | Change `tmux_session` to `session_id` everywhere. |

### 3.3 `test/tree-view/agent-status-tree-provider.test.ts`

| Area | Change |
|------|--------|
| `createMockTask()` | Add `session_id: "agent-my-app"`. |
| `createMockRegistry()` | Change default version to `2`. |
| Existing `version: 2` test | Update: version 2 should now be accepted. |
| New tests | v1 compat, v2 primary, both-fields precedence, Session label. |

---

## 4. Backward Compatibility Strategy

All compatibility logic lives in a single `normalizeTask()` function called
inside `readRegistry()`. Downstream code only sees `session_id` populated.

```
tasks.json (v1 or v2)
        │
        ▼
   readRegistry()
        │
        ├─ version 1: normalizeTask() copies tmux_session → session_id
        ├─ version 2: normalizeTask() keeps session_id as-is
        │
        ▼
  AgentTask with session_id guaranteed
```

### normalizeTask() pseudo-logic

```typescript
function normalizeTask(raw: Record<string, unknown>): AgentTask | null {
  const sessionId = (raw.session_id ?? raw.tmux_session) as string | undefined;
  if (!sessionId) return null;

  return {
    ...raw,
    session_id: sessionId,
    tmux_session: raw.tmux_session as string | undefined,
  } as AgentTask;
}
```

---

## 5. Test Plan

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `reads v1 registry with tmux_session` | v1 file normalized so `session_id` equals tmux_session value |
| 2 | `reads v2 registry with session_id` | v2 file read directly |
| 3 | `session_id takes precedence over tmux_session` | If both present, `session_id` wins |
| 4 | `detail node labeled "Session"` | Child detail uses new label |
| 5 | `isValidSessionId works` | Same regex behavior |
| 6 | `deprecated isValidTmuxSession still exported` | Backward compat |

---

## 6. Risks

| Risk | Mitigation |
|------|-----------|
| Launcher writes v2 before extension updated | Current code rejects v2 — this migration is urgent |
| Both fields present | `normalizeTask()` prefers `session_id` |
| External consumers import `isValidTmuxSession` | Deprecated re-export preserves compat |
