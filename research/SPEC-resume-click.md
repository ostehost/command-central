## Uncovered Items
- `focusAgentTerminal` does not early-redirect non-running tasks to `resumeAgentSession` as a safety fallback.
- `commandCentral.focusAgentTerminal` is still contributed for all `agentTask.*` context items, so non-running tasks can still invoke focus flow.

# SPEC: Click Agent → Resume Interactive Session

## Problem
When clicking a completed/stopped/failed agent in the sidebar, the `focusAgentTerminal` command tries to find and focus the old Ghostty window first. If the window still exists (we never close launched terminals), it focuses it and returns — the user never sees the Resume Session option.

## Desired Behavior
**Clicking any non-running agent = resume its Claude Code session interactively in a new Ghostty terminal. Always. No quick pick.**

- Running agents → focus existing terminal (unchanged)
- Non-running agents (completed, stopped, failed, completed_stale) → resume session

## Changes Required

### 1. Tree Provider: Change click command for non-running agents
**File:** `src/providers/agent-status-tree-provider.ts`
**Method:** `createTaskItem()` (around line 1128)

Currently ALL tasks get:
```ts
item.command = {
    command: "commandCentral.focusAgentTerminal",
    title: "Focus Terminal",
    arguments: [{ type: "task" as const, task }],
};
```

Change to: if `task.status !== "running"`, set the command to `commandCentral.resumeAgentSession` instead:
```ts
const isRunning = task.status === "running";
item.command = {
    command: isRunning ? "commandCentral.focusAgentTerminal" : "commandCentral.resumeAgentSession",
    title: isRunning ? "Focus Terminal" : "Resume Session",
    arguments: [{ type: "task" as const, task }],
};
```

### 2. Resume command: handle fallback gracefully
**File:** `src/extension.ts` (around line 1091-1131)

The existing `commandCentral.resumeAgentSession` command is mostly correct but needs:
- If no Claude session found, show a message AND fall back to focusing the old terminal (or showing diff)
- The `open -a Ghostty --args -e` invocation should work for interactive `claude --resume`

### 3. Clean up dead-agent logic in focusAgentTerminal
**File:** `src/extension.ts` (around lines 730-820)

The big `if (task.status !== "running")` block with sessionAlive checks, bundle focus attempts, quick pick, etc. can be **simplified** since non-running agents will no longer hit this command. But keep it as a safety fallback — if somehow called for a non-running agent, redirect to `resumeAgentSession`:

```ts
if (task && task.status !== "running") {
    // Non-running agents should use resumeAgentSession directly
    // (tree provider routes there, but handle direct invocations too)
    vscode.commands.executeCommand("commandCentral.resumeAgentSession", node);
    return;
}
```

### 4. Tests
- Update any tests in `src/providers/__tests__/agent-status-tree-provider.test.ts` that assert the click command
- Verify running agents still get `focusAgentTerminal`
- Verify completed/stopped/failed agents get `resumeAgentSession`

## Files to Edit
1. `src/providers/agent-status-tree-provider.ts` — createTaskItem() command routing
2. `src/extension.ts` — simplify focusAgentTerminal dead-agent block, improve resumeAgentSession fallback

## Files NOT to Touch
- `src/discovery/session-resolver.ts` — works correctly
- Any test files outside of the tree provider tests
- Any launcher/hooks code

## Verification
```bash
just check   # must pass — 780+ tests, 0 failures
```

SPEC COMPLETE
