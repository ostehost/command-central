# Computer-Use Visual Review: Review Lane Placement

**Task ID:** `cc-review-lane-visual-strict-20260527-1900`
**Date:** 2026-05-27
**Reviewer:** Claude Opus 4.7 (terminal reviewer)
**HEAD:** `18abe19d docs(review): record review-lane validation`
**Target commit:** `6c67a25f test(tree): cover auto-review lane placement`

---

## Verdict: BLOCKED

**BLOCKER: COMPUTER_USE_UNAVAILABLE**

### Computer-Use Tool Availability Evidence

| Tool | Available? | Usable? | Why |
|------|-----------|---------|-----|
| `mcp__claude-in-chrome__computer` | Yes (schema loaded via ToolSearch) | **No** | `list_connected_browsers` returned `[]` — no Chrome instance connected |
| `mcp__claude-in-chrome__tabs_context_mcp` | Yes | **No** | Requires connected browser |
| Desktop-level computer-use (Anthropic CUA) | **No** | N/A | Not available in this Claude Code terminal |

**Root cause:** Chrome MCP tools operate on Chrome browser tabs, not VS Code's native Electron UI. Even with a connected Chrome, the Agent Status tree view (a VS Code TreeDataProvider sidebar) cannot be inspected via Chrome DevTools or Chrome tab automation. A desktop-level screenshot/input tool (Anthropic Computer Use API) would be required to observe VS Code windows, and that tool is not available in this environment.

**Actions attempted:**
1. `ToolSearch("mcp chrome computer screenshot")` — loaded 10 Chrome MCP tool schemas successfully
2. `mcp__claude-in-chrome__list_connected_browsers()` — returned `[]`
3. No screenshot path or visible UI observation was possible

---

## Code-Level Analysis (Shell-Only — Not Sufficient for Visual Proof)

### 1. Manual Reviewer Placement (Expected: Root-Visible)

**Current live registry** (`~/.config/ghostty-launcher/tasks.json`) contains three reviewer tasks:

| Task ID | `project_dir` | `role` | `isAutoReviewLane()` |
|---------|---------------|--------|---------------------|
| `review-cc-review-lane-ui-20260527-1724` | `/Users/ostehost/projects/command-central` | reviewer | **false** → root task ✓ |
| `cc-review-lane-computer-use-20260527-1831` | `/Users/ostehost/projects/command-central` | reviewer | **false** → root task ✓ |
| `cc-review-lane-visual-strict-20260527-1900` | `/Users/ostehost/projects/command-central` | reviewer | **false** → root task ✓ |

All three are in a real project directory, not `/tmp/*-review`. The `isAutoReviewLane()` guard (`auto-review-lane.ts:15`) requires `TMP_REVIEW_DIR_PATTERN = /^\/tmp\/.*-review$/` to match first — none of these match. **Manual reviewer lanes correctly remain as primary/root-visible launcher tasks.**

### 2. Auto-Review /tmp Lane Placement (Expected: Hidden/Nested)

The `isAutoReviewLane()` function requires:
1. `project_dir` matches `/^\/tmp\/.*-review$/` (mandatory gate)
2. Plus at least one corroborating signal: `review-` ID prefix, `reviewer` role, or `/REVIEW-` in handoff path

`getScopedLauncherTasks()` (`agent-status-tree-provider.ts:2511`) filters these out of root:
```
return tasks.filter((t) => !isAutoReviewLane(t));
```

`getAutoReviewLaneChildren()` (`agent-status-tree-provider.ts:5035-5056`) nests them under their source task as detail nodes with `icon: "eye"` and a click-to-open-handoff command.

**No /tmp auto-review lanes exist in the current live registry** — correct, since the current review tasks were launched directly in the real project dir.

### 3. Nested Row Label Assessment

The label renders as:
```
Review: review-cc-review-lane-source: completed
```

Format: `Review: ${lane.id}: ${lane.status}` (label + value in tree item).

**Assessment:** The `Review: review-` prefix is **redundant** — the word "Review" appears twice (once as the label prefix, once as the `review-` ID prefix). For next release, stripping the `review-` prefix from the displayed ID would improve readability:
```
Review: cc-review-lane-source: completed    ← cleaner
```

This is cosmetic, not a correctness issue. The current rendering is understandable but noisy.

---

## Gate Results

| Gate | Result | Detail |
|------|--------|--------|
| `bun test ...auto-review-lane.test.ts ...agent-status-tree-provider.test.ts -t 'auto-review\|hides tmp'` | **6 pass, 0 fail** | 9.12s, 20 expect() calls |
| `just check` (biome ci + tsc + knip) | **PASS** | 244 files checked, no issues |
| `just test-unit` | **555 pass, 0 fail** | git-sort (129) + utils/services (426) |

### Git State

```
HEAD:   18abe19d docs(review): record review-lane validation
Branch: main (ahead of origin/main by 33 commits)
Tree:   clean (nothing to commit)
```

---

## Manager Determination

**Current state is correct under current code** — the filtering logic, test coverage, and live registry behavior all align. Manual reviewer lanes in real project dirs appear as root tasks; auto-review lanes in `/tmp/*-review` dirs are hidden and nested.

**However, this review cannot be fully certified** because the strict computer-use visual proof requirement was not met. The Chrome MCP tooling cannot observe VS Code native UI, and no desktop-level computer-use tool is available.

**UX note for next release:** The `Review: review-...` label redundancy should be addressed. Recommend stripping the `review-` prefix from the displayed lane ID in `getAutoReviewLaneChildren()`.

### Previous Shell-Only Review Status

The prior shell-only review (`18abe19d docs(review): record review-lane validation`) validated code correctness and test coverage. This review **confirms those findings are accurate** but **cannot supersede** the shell-only review with visual proof — both remain shell-only validated. A future review with desktop computer-use capability would be needed to provide visual certification.

---

*Handoff written by terminal reviewer. Verdict BLOCKED due to computer-use tool gap, not code defects.*
