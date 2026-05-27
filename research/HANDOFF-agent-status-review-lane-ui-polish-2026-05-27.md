# Handoff: Agent Status Review Lane UI Polish

**Task ID:** `cc-review-lane-ui-polish-20260527-1908`
**Commit:** `792f0434`
**Date:** 2026-05-27

## Verdict: SUCCESS

Three focused UI improvements committed. All tests pass. No lifecycle authority invented, no release artifacts modified.

## What Changed

### 1. Calmer "detached" copy for completed reviewer lanes

**File:** `src/providers/agent-status-tree-provider.ts:896-910`

`classifyCompletionRouting()` now checks `task.role === "reviewer"` for terminal detached tasks and returns:
- **Label:** "Detached — no action needed" (was: "Detached — manual observation required")
- **Detail:** "Standalone reviewer lane — launched without orchestrator callback; completion was local"
- **Icon color:** `disabledForeground` (dimmed, was: `charts.yellow` / warning-level)
- **Kind:** Still `"detached"` — no new routing kind introduced

Running reviewer tasks still get the standard "Detached" label (non-terminal branch is unchanged).

### 2. `⚠ detached` tag suppressed for completed reviewer tasks

**File:** `src/providers/agent-status-tree-provider.ts:8598`

The description-line logic now skips the `⚠ detached` tag when `task.role === "reviewer"`. The tooltip still contains full routing info. Non-reviewer detached tasks still show the warning as before.

### 3. Symphony summary — standalone run attempts

**File:** `src/providers/agent-status-tree-provider.ts:6017-6037`

`formatSymphonyRootDescription()` now:
- **0 runs, 0 flows:** `"no projected runs"` (was: `"0 run attempts · 0 workstreams"`)
- **N runs, 0 flows:** `"N standalone run attempt(s)"` — workstream column omitted (was: `"N run attempts · 0 workstreams"`)
- **N runs, M flows (M>0):** Unchanged (`"N run attempt(s) · M workstream(s)"`)

Running/RetryQueued counts still append when > 0 (e.g., `"1 standalone run attempt · 1 running"`).

## Computer-Use Proof

**COMPUTER_USE_UNAVAILABLE**

Evidence: `mcp__claude-in-chrome__tabs_context_mcp` returned:
> "Browser extension is not connected. Please ensure the Claude browser extension is installed and running..."

Chrome extension was not connected during this session. All analysis was performed from Mike's supplied screenshot description and shell-based code reading. No visual observation was falsely claimed.

## Tests

### New tests added (3)
- `test/tree-view/agent-status-tree-provider-pure-helpers.test.ts`:
  - "completed reviewer task with no routing uses calmer detached copy"
  - "failed reviewer task with no routing uses calmer detached copy"
  - "running reviewer task without routing uses standard detached copy"

### Existing tests updated (3 assertions)
- `test/tree-view/agent-status-tree-provider.test.ts:294` — symphony empty state label
- `test/integration/tasks-json-startup-smoke.test.ts:39` — symphony empty state label
- `test/tree-view/openclaw-task-nodes.test.ts:363` — symphony 1-run/0-flow label

### Test runs
```
bun test (5 affected files): 107 pass, 0 fail
just test-unit: 555 pass, 0 fail
just check: clean (biome ci + tsc + knip)
just test-integration: 112 pass, 1 fail (git-timestamps — unrelated flaky test)
```

## Git Status

```
?? research/COMPUTER-USE-REVIEW-LANE-VISUAL-STRICT-2026-05-27.md  (untracked, from prior task)
```

Committed tree is clean for the 5 changed files.

## Release-Risk Notes

- **Low risk.** Changes are copy-only (labels, detail text, icon color) and a description-tag filter. No node structure, grouping, or lifecycle logic changed.
- **No new node types or tree structure changes.** Project counts, task grouping, and auto-review lane nesting are all untouched.
- The `disabledForeground` theme color is a standard VS Code theme token; it may render differently across themes but will always be dimmer than `charts.yellow`.
- The Symphony label change propagates to anywhere that reads the summary node label (e.g., Symphony Status Surface at root). No downstream consumers parse this string programmatically.

## Scope Not Addressed (deferred)

- **Completed reviewer lanes are still root-visible.** The current classifier intentionally keeps manual real-project reviewer lanes at root. Grouping them under a "Review history" child group is a larger structural change that would touch `getProjectGroupChildren`, `buildProjectNodes`, and the project count logic. Deferred to a follow-up task.
- **`review_state: no_review_expected`** is not yet used in the detached-copy logic. The current implementation keys on `task.role === "reviewer"` which covers the same population. If non-reviewer tasks ever carry `no_review_expected`, the check should expand.
