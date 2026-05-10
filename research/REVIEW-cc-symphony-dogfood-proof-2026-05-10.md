# Review: Command Central Symphony Dogfood — Proof / Read-Only Lane

Date: 2026-05-10
Reviewer task_id: `cc-symphony-dogfood-proof-review-20260510-0955`
Implementation task_id: `cc-symphony-dogfood-workstreams-impl-20260510-0955`
Repo: `/Users/ostehost/projects/command-central`
Branch: `dogfood-symphony-20260510`
Base commit: `ec389d2a`
Implementation commit: `9d1ef965` — `feat(agent-status): tighten Symphony dashboard to spec runtime-snapshot vocabulary`

## Verdict

**Accept.** No BLOCKERs. No boundary violations. Implementation matches
the dogfood handoff. All gates green, including strict `just ci` rerun by
the lead. Three process-layer gaps recorded for owner-layer follow-up.

| Severity | Count | Detail |
| --- | --- | --- |
| BLOCKER | 0 | — |
| WARNING | 0 | — |
| NIT (process) | 3 | (a) Remote-spawn preflight needs scope-upgrade so dogfood lanes don't trip read-only guards. (b) Same-project lanes share `session_id` (`agent-command-central` for both impl and review), which weakens session-keyed disambiguation when multiple lanes run on one project. (c) `.claude/scheduled_tasks.lock` written by the reviewer's Claude Code wakeup scheduler trips the launcher's `dirty_baseline` and surfaces impl as `completed_dirty` while the reviewer is still active. |

## Implementation diff (commit `9d1ef965`)

- `src/providers/agent-status-tree-provider.ts` — `getSymphonyDashboardDetailChildren` rewritten to emit Symphony spec runtime-snapshot vocabulary: `Orchestrator Runtime State`, `running`, `retrying`, `codex_totals.input_tokens`, `codex_totals.output_tokens`, `codex_totals.total_tokens`, `codex_totals.seconds_running`, `rate_limits`. Unprovided fields degrade to literal `Not provided by lifecycle owner` rather than synthesised `0`. Synthetic `Turns`/`Tokens`/`Runtime`/`Rate-limit snapshots` aggregations removed. `Released` row remains conditional on source evidence.
- `test/tree-view/openclaw-task-nodes.test.ts` — dashboard test updated to the new vocabulary including the honest defaults; new focused test `Symphony Workstreams group children by explicit identity, not workstream/task title text` pins the explicit-identity contract on `findLauncherTaskForFlowTask` → `openClawTaskMatchesLauncherTask` (`taskId` ∨ `runId` ∨ normalised `session_id` only — never `prompt_summary`/title text).
- `research/HANDOFF-cc-symphony-dogfood-workstreams-impl-2026-05-10.md` — implementation handoff (committed alongside).

## Verification (read-only, post-impl)

| Command | Result |
| --- | --- |
| `bun test test/tree-view/openclaw-task-nodes.test.ts` | ✅ 32 pass / 0 fail / 140 expect() in 22.25s |
| `bunx tsc --noEmit --pretty false` | ✅ exit 0, no output |
| `git diff --check` | ✅ exit 0, no output |
| `just check` | ✅ Biome CI clean (240 files), tsc + knip clean |
| `just test` (full suite) | ✅ 1536 pass / 1 skip / 0 fail / 4316 expect() across 118 files in 10.44s |
| `just ci` (strict) — rerun by lead, log `/tmp/cc-dogfood-just-ci-20260510.log` | ✅ 1536 pass / 1 skip / 0 fail / 4316 expect(); "✅ CI checks passed!" |

`git status` after impl commit: working tree clean except `?? .claude/scheduled_tasks.lock` (reviewer-owned harness artifact — see NIT(c)).

## Live dogfood evidence — both lanes visible

Both lanes are real launcher-spawned Ghostty sessions registered with
explicit identity and source-owned provenance.

| Field | Implementation lane | Review lane |
| --- | --- | --- |
| `id` / `task_id` / `flow_id` | `cc-symphony-dogfood-workstreams-impl-20260510-0955` | `cc-symphony-dogfood-proof-review-20260510-0955` |
| `role` | `developer` | `reviewer` |
| `status` | `completed_dirty` (exit 0, see NIT(c)) | `running` |
| `source_authority` | `launcher` | `launcher` |
| `provenance.adapter_kind` | `ghostty-launcher` (`oste-spawn.sh`) | `ghostty-launcher` (`oste-spawn.sh`) |
| `project_id` / `project_dir` | `command-central` / `/Users/ostehost/projects/command-central` | same |
| `session_id` | `agent-command-central` | `agent-command-central` (same — see NIT(b)) |
| `started_at` | `2026-05-10T14:01:33Z` | `2026-05-10T14:01:43Z` |
| `start_sha` → `agent_commit` | `ec389d2a…` → `9d1ef965a…` | `ec389d2a…` → — |
| `handoff_file` | `research/HANDOFF-cc-symphony-dogfood-workstreams-impl-2026-05-10.md` | `research/REVIEW-cc-symphony-dogfood-proof-2026-05-10.md` |

Source-owned evidence is read from `~/.config/ghostty-launcher/tasks.json`
plus the launcher finalizer artifacts in `/tmp/oste-pending-review/`,
`/tmp/oste-stop-complete-…`, `/tmp/oste-complete-…`, and
`/tmp/oste-exec-receipt-…`. The existing installed-VSIX proof harness
(`test/integration/installed-vsix-proof-suite.ts`,
`installed-vsix-proof-shared.ts: hasRequiredSymphonyRoots`) already keys
on the `Symphony` / `Workstreams` / `Run Attempts` labels these lanes
project — no synthesised rows, no filesystem crawl.

## Boundary scan

Diff scanned for forbidden surfaces. None added.

| Boundary | Result |
| --- | --- |
| No drag/drop kanban | ✅ |
| No retry/cancel buttons (the `retrying` row is a count, not an action; launcher rows still own `cancel`/`requestReview`/`dispatchFixup` envelopes) | ✅ |
| No Linear polling, no tracker writes (existing `tracker_kind`/`issue_id` fields stay read-only projections) | ✅ |
| No scheduler ownership (no new timers/poll loops) | ✅ |
| No workspace creation/cleanup, no filesystem mutation in diff | ✅ |
| No lifecycle synthesis — `Orchestrator Runtime State` honestly reports `Not provided by lifecycle owner` | ✅ |
| Workstream membership keyed on explicit identity only | ✅ (now pinned by test) |
| Symphony stays inside Agent Status as a top-level root; no Activity Bar container or sibling view | ✅ |

## Process gaps (owner-layer carry-overs)

These are NIT-severity tooling/process gaps surfaced by dogfooding the
delegation. None require Command Central changes.

1. **Remote-spawn preflight scope-upgrade.** The launcher's spawn-time
   guards still treat the dogfood-spawned reviewer/implementor lanes
   under a baseline read-only profile, then upgrade scope mid-flight via
   `dirty_baseline`. A first-class scope-upgrade preflight would let
   delegated lanes declare their write surface (e.g. `research/REVIEW-…`)
   before the spawn completes, removing the baseline bypass dance.
2. **Same-project lanes share `session_id`.** Both impl and review are
   registered with `session_id: agent-command-central`. Identity grouping
   in Command Central still works because `id`/`task_id`/`flow_id` are
   distinct per row, but session-keyed joins (`childSessionKey`,
   discovered-agent fallback) collapse the two lanes onto one session.
   Owner-layer fix: scope `session_id` per-lane (e.g.
   `agent-command-central:<task_id>`) at spawn time.
3. **`.claude/scheduled_tasks.lock` causes `completed_dirty`.** While the
   reviewer is active, the Claude Code wakeup scheduler creates
   `.claude/scheduled_tasks.lock` in the project working directory. The
   launcher's pre-guard auto-commit correctly skips the file (it isn't
   impl-owned), but its presence trips the dirty signal and the impl
   lane is reported as `completed_dirty` despite a clean `exit_code=0`
   commit. Owner-layer fix: add the path to the launcher's
   `dirty_baseline` allow-list (or to a global `.gitignore`), or have
   the Claude Code harness clean the lock at session exit.

## Reviewer write hygiene

Only `research/REVIEW-cc-symphony-dogfood-proof-2026-05-10.md` is the
intentional write of this lane. No source/test edits, no `--no-verify`,
no push, no tag, no GitHub release, no tracker mutation. The
`.claude/scheduled_tasks.lock` artifact is harness-owned and not part of
this commit.

REVIEW COMPLETE
