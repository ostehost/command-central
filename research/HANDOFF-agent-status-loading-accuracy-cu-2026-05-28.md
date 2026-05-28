# Handoff — Agent Status loading/working visual accuracy

**Task ID:** `cc-agent-status-loading-accuracy-cu-20260528-0032`
**Date:** 2026-05-28
**Role:** developer / computer-use UI accuracy lane
**Verdict:** **FIXED**

## Host / repo proof

```
hostname      : MacBookPro.lan
whoami        : ostehost
pwd           : /Users/ostehost/projects/command-central
branch        : main (ahead of origin/main by 48)
start HEAD    : 524a56fa (fix(preview-status): default to show and hoist global --state-dir)
start tree    : 0b9b0584bf45ae92d76c55a0ba7d0331df3a0e15
```

## Computer-use status

`COMPUTER_USE_UNAVAILABLE` for the **live VS Code Command Central sidebar** — the chrome-MCP tools available in this session can only drive a browser, not the native VS Code window, and no VSIX install/uninstall was requested. Visual evidence used: the dispatched screenshot at `/Users/ostehost/Desktop/Screenshot 2026-05-28 at 12.27.29 AM.png` (copied to `/private/tmp/cc-ui-loading-screenshot.png`, 131,503 bytes), read directly. Deterministic verification: bun:test assertions on `TreeItem.iconPath.id` and `TreeItem.description` against the production code path.

## Screenshot analysis

Inspected `/private/tmp/cc-ui-loading-screenshot.png` directly. The pane shows:

- Header: `Symphony Status Surface: 3 standalone run attempts · 1 running`
- Project group: `🧩 COMMAND CENTRAL ▼ (3) 1 working · 2 done`
- Row 1: yellow **animated sync spinner** icon · `cc-agent-status-fresh-lane-20260527-2111` · `opus · 🔗 1411323e (interactive)` — counted in the "1 working" total
- Row 2: yellow warning triangle · `cc-rc47-async-preview-hardening-20260528-0020` · `5 files · +996/-17 · opus · 59s ago · ⚠ detached · ⚠ lifecycle co…`
- Row 3: yellow warning triangle · `cc-agent-status-pane-liveness-fix-20260527-2323` · `3 files · +277/-9 · opus · 50m ago · ⚠ detached · ⚠ lifecycle co…`

## Truth table (rows visible in screenshot)

Sources cross-referenced: `~/.config/ghostty-launcher/tasks.json`, `/tmp/oste-pending-review/*.json`, `tmux -S … display-message -t <pane> -p '#{pane_current_command}|#{pane_pid}'`, and `pgrep -P … / ps -o comm=` on descendants.

| Row / task id | Launcher status | Pending-review receipt | tmux window/pane | Pane current_command (now) | Agent descendant (now) | UI rendered | Accurate? |
|---|---|---|---|---|---|---|---|
| `cc-agent-status-fresh-lane-20260527-2111` | `running` (reviewer, role=reviewer; started 2026-05-28T01:00:19Z) | none (interactive reviewer) | window `@35`, pane `%35`, alive | `bash` (was `claude` in screenshot moment; `claude` now at depth 4 under pane pid) | `claude` (PID 35518) — pane evidence **alive** | yellow `sync~spin` + `(interactive)` description | **Misleading**: spinner animates forever even though the lane is idle at a Claude prompt awaiting input. `(interactive)` hint exists but the spinning icon dominates the visual. → **FIXED** below. |
| `cc-rc47-async-preview-hardening-20260528-0020` | `completed` (exit_code=0, completed_at=2026-05-28T04:25:51Z) | present, `status=completed` | window `@37`, pane `%37`, alive | `bash` | none (only bash) — pane evidence **dead** | warning triangle + `detached · ⚠ lifecycle conflict` | **Accurate**: completed with a still-attached terminal that has no agent process. Existing lifecycle-conflict copy is correct. |
| `cc-agent-status-pane-liveness-fix-20260527-2323` | `completed` (exit_code=0, completed_at=2026-05-28T03:35:55Z) | present, `status=completed` | window `@36`, pane `%36`, alive | `bash` | none (only bash) — pane evidence **dead** | warning triangle + `detached · ⚠ lifecycle conflict` | **Accurate**: identical pattern to row 2. |

## Root cause

In `src/providers/agent-status-tree-provider.ts::createTaskItem` the icon resolver had no branch for `interactiveAwaiting`:

```ts
item.iconPath =
    lifecycleConflict.kind === "live-process-conflict"
        ? warning(orange)
        : task.status === "completed_stale" || isStuck
            ? warning(yellow)
            : isReviewed
                ? pass(green)
                : getStatusThemeIcon(task.status); // → sync~spin (animated) for "running"
```

`interactiveAwaiting = isAgentStuck(task) && hasPositiveLivenessEvidence(task)` is already computed two screens above and already drives the description hint (`(interactive)`), but the icon stayed as the running-status default (`sync~spin`, animated yellow). To the user, an animated spinner is the loudest "loading/working" signal in the tree — so a lane that has been parked at a Claude REPL for hours looked indistinguishable from one actively churning through a turn.

## Fix

Single tree-provider edit, single insertion of an `interactiveAwaiting` branch in the icon ladder:

- **When** a task is `status === "running"`, **and** the stuck heuristic has fired (no stream activity past the threshold), **and** we have positive tmux pane evidence the lane is alive (`inspectTmuxPaneAgent("alive")`) — i.e., the existing definition of `interactiveAwaiting` — render `comment-discussion` (yellow), a non-animated codicon that semantically reads "awaiting reply", instead of `sync~spin`.
- Order of precedence preserved: `live-process-conflict` (orange warning) > `completed_stale || isStuck` (yellow warning) > `interactiveAwaiting` (yellow comment-discussion, NEW) > `isReviewed` (green pass) > `getStatusThemeIcon(task.status)` (default).
- Backend-neutral: the branch keys off `interactiveAwaiting`, which only flips true when **positive** pane evidence exists. Unknown-evidence and dead-evidence paths retain the default (spinner or downgraded status respectively). No agent name (claude/codex/aider) appears in the new branch — agent/model neutrality preserved.

The `(interactive)` description annotation already exists at lines 8646–8647 and is unchanged. The launcher project-group count "(3) 1 working · 2 done" is also unchanged in this fix — reclassifying running-but-idle lanes as a separate `interactive` count is a larger UX call (touches summary tooltip, sort order, and badging) and is left as a follow-up.

## Files changed

| File | Why |
|---|---|
| `src/providers/agent-status-tree-provider.ts` | Add the `interactiveAwaiting` branch to the icon ladder in `createTaskItem`. |
| `test/tree-view/agent-status-launcher-interactive-claude.test.ts` | Extend the existing regression-guard suite with two icon-contract tests: (a) screenshot scenario — positive pane evidence + stale stream must render `comment-discussion`, not `sync~spin`; (b) backend-neutral / unknown-evidence on a fresh-running task must keep the default `sync~spin` since idle vs active is indistinguishable. |

No edits to `justfile`, `.gitignore`, `scripts-v2/preview-status.ts`, or `test/scripts-v2/preview-status.test.ts` — the concurrent `cc-preview-status-cli-fixup-20260528-0029` lane's surface is untouched.

## Tests / checks run

- `bun test test/tree-view/agent-status-launcher-interactive-claude.test.ts` → **5/5 pass** (3 existing + 2 new).
- `bun test test/tree-view/agent-status-launcher-interactive-claude.test.ts test/tree-view/agent-status-tree-provider-rendering.test.ts test/tree-view/agent-status-tree-provider.test.ts test/tree-view/agent-status-pending-review-truth.test.ts test/tree-view/agent-status-review-and-handoff.test.ts` → **79/79 pass**.
- `bun test test/tree-view/` (full directory) → **364/365 pass, 1 fail**. The single failure (`AgentStatusTreeProvider — discovery > dogfood discovery integration > discovery diagnostics report shows retained vs filtered scanner matches`) was reproduced on bare `main` *before* this change (verified via `git stash` round-trip). Pre-existing flake, not caused by this work.
- `just check` (biome ci + tsc + knip) → **clean** ("✅ Checks complete!").

## Remaining risks / next iteration

- **Counts copy still says "1 working".** A genuinely-idle interactive REPL is technically `status === running` but not actively working. Reclassifying these into a third `interactive` bucket (instead of `working`) touches `formatSummaryCounts`, the project-group descriptor, summary tooltip, and possibly sort order. This was deliberately scoped out of the present minimal fix; recommend filing a follow-up.
- **Icon color stayed `charts.yellow`** to preserve at-a-glance visual weight (so the row still draws the eye), but a case could be made for `descriptionForeground` (muted) instead. Worth a quick visual A/B in the live VS Code UI on the next lane.
- **No live VS Code render verification** was performed in this lane (no VSIX install/uninstall, no automation against the native window). The fix is type-checked, lint-clean, and asserted at the `TreeItem.iconPath` / `TreeItem.description` boundary, which is the smallest reliable contract — but Mike may want to install the VSIX once the lane completes and eyeball the row.
- **Pre-existing test flake** in `agent-status-tree-provider-discovery.test.ts` (dogfood discovery → diagnostics report) needs an owner; tracked here as known-fail-on-main.

## Lifecycle compliance

No preview cut, push, tag, or Marketplace publish was performed. No `--no-verify`. No stash, reset, clean, or revert. `git stash`/`git stash pop` was used briefly to verify the discovery flake is pre-existing; the stash was popped and the tree restored before commit. All changes are local; nothing was pushed.
