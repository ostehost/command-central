# SPEC: Click-to-Resume Agent Sessions

> Feature: When clicking an agent in the sidebar, resume its Claude Code session interactively instead of opening a blank terminal.

## Problem

Currently, clicking a completed/stopped agent in the sidebar either:
1. Opens a fresh Ghostty terminal at the project directory (no Claude Code session)
2. Shows "No terminal available" or falls through to diff view

The user wants to **resume the interactive Claude Code session** to continue steering the agent.

## Solution

Add a "Resume Session" action that:
1. Detects the Claude Code session ID from the agent
2. Runs `claude --resume <session-id>` in a Ghostty terminal
3. Integrates with the sidebar as a context menu action + click behavior for completed agents

## Architecture

### Phase 1: Session ID Capture (Agent Status Provider)

**File: `src/providers/agent-status-tree-provider.ts`**

For **discovered agents**, the `sessionId` field on `DiscoveredAgent` already exists.

For **launcher tasks** (`AgentTask`), the `session_id` field exists but holds the tmux session name, not the Claude Code session UUID. We need the Claude Code session ID.

**Source of Claude Code session IDs:**
- `~/.claude/projects/-{project-path-escaped}/{uuid}.jsonl` — session files
- The UUID in the filename IS the Claude Code session ID
- We match by project directory + recency (most recent `.jsonl` file)

**New function in `src/discovery/session-resolver.ts`:**
```typescript
export async function resolveClaudeSessionId(projectDir: string): Promise<string | null>
```
- Escapes `projectDir` to match Claude's directory naming (`/` → `-`)
- Lists `~/.claude/projects/{escaped}/` for `.jsonl` files
- Returns the UUID of the most recently modified `.jsonl` file
- Returns null if no sessions found or dir doesn't exist

### Phase 2: Resume Command

**File: `src/extension.ts`** — new registered command `commandCentral.resumeAgentSession`

Logic:
1. Get projectDir from the clicked node (task or discovered agent)
2. Call `resolveClaudeSessionId(projectDir)` to get the Claude session UUID
3. If found:
   - Check if there's a Ghostty bundle for this project (via SessionStore)
   - If Ghostty bundle exists: `osascript` to open new tab in that Ghostty instance running `claude --resume <uuid>`
   - If no bundle: open default Ghostty with `claude --resume <uuid> --cwd <projectDir>`
4. If no session found: show info message "No Claude Code session found for this project. Start a new one?"

**How to open `claude --resume` in Ghostty:**
```typescript
// Option A: New Ghostty window via shell command
execFileAsync('open', ['-a', 'Ghostty', '--args', '-e', `cd ${projectDir} && claude --resume ${sessionId}`]);

// Option B: Send command to existing Ghostty via persist socket (if running)
// This is more complex — start with Option A
```

### Phase 3: Sidebar Integration

**File: `src/providers/agent-status-tree-provider.ts`**

Add `commandCentral.resumeAgentSession` to context menus for:
- Completed agents (both task and discovered)
- Stopped agents
- Failed agents

**File: `package.json`**

Add new command + menu contribution:
```json
{
  "command": "commandCentral.resumeAgentSession",
  "title": "Resume Session",
  "icon": "$(play)",
  "category": "Command Central"
}
```

Add to `view/item/context` menus with `when` clause:
- `viewItem =~ /agent-(completed|stopped|failed)/`

### Phase 4: Click Behavior Update

**File: `src/extension.ts`** — modify `commandCentral.activateAgent`

For completed/stopped/failed agents, change the click behavior:
- **Current:** Try to focus Ghostty window → fall through to diff view
- **New:** Try to focus Ghostty window → if no window, offer to resume session

Add to the dead-session fallback (around line 787):
```typescript
// Session is dead — offer resume instead of just showing diff
const claudeSessionId = await resolveClaudeSessionId(projectDir);
if (claudeSessionId) {
    const choice = await vscode.window.showInformationMessage(
        `Agent "${task.id}" has ended. Resume its Claude Code session?`,
        'Resume', 'View Diff'
    );
    if (choice === 'Resume') {
        vscode.commands.executeCommand('commandCentral.resumeAgentSession', node);
        return;
    }
}
// Fall through to diff view
```

## Files to Create
- `src/discovery/session-resolver.ts` — NEW (~60 lines)

## Files to Modify
- `src/extension.ts` — add resume command + update activate behavior (~50 lines changed)
- `src/providers/agent-status-tree-provider.ts` — add context menu when clause (~10 lines)
- `package.json` — add command + menu contribution (~20 lines)

## Files NOT to Touch
- `src/ghostty/window-focus.ts` — no changes needed
- `src/services/session-store.ts` — no changes needed
- `src/discovery/types.ts` — no changes needed
- Any test files (tests are a separate phase)

## Tests

**New test file: `src/discovery/__tests__/session-resolver.test.ts`**

1. `resolveClaudeSessionId` returns most recent session UUID for known project
2. `resolveClaudeSessionId` returns null for unknown project
3. `resolveClaudeSessionId` handles missing ~/.claude directory
4. `resolveClaudeSessionId` handles empty session directory
5. `resolveClaudeSessionId` escapes project paths correctly (/ → -)

**Additions to existing tests:**
6. Integration: resume command triggers with correct session ID
7. Context menu shows "Resume Session" for completed agents
8. Activate command offers resume dialog for dead sessions

## Out of Scope
- Inline steering input in sidebar (future feature)
- Resume for non-Claude agents (Codex, Gemini)
- Auto-resume on click (always ask first for v1)

SPEC COMPLETE
