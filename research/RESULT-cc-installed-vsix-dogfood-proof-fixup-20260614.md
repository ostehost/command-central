# RESULT — cc-installed-vsix-dogfood-proof-fixup-20260614

**Lane role:** contract-failure recovery / review lane
**Date:** 2026-06-14
**Reviewed commit:** `d80c4805` — `chore: auto-commit agent work [cc-installed-vsix-dogfood-proof-20260614]`
**Finalized as:** `5ef4c4bd` — `fix(agent-status): render detached truth for liveness-unobservable running lanes`
**Repo:** `~/projects/command-central`
**Verdict:** ✅ Change **ACCEPTED** (no fix, no revert). Logic verified sound; the work was
finalized into a proper commit with full test coverage during this lane's session. Missing
handoff now written.

---

## 1. Why the prior lane contract-failed

The previous lane `cc-installed-vsix-dogfood-proof-20260614` produced a real, correct
code commit (`d80c4805`) but **never wrote its required durable handoff**
`research/RESULT-cc-installed-vsix-dogfood-proof-20260614.md`. Under the launcher's
artifact contract a missing handoff path is a hard `contract_failure`, independent of
whether the underlying code work was sound. So the failure was a **process/artifact
gap, not a code defect** — the commit landed, the deliverable receipt did not.

This fixup lane's job was narrow: review the commit, confirm or repair it, and write the
missing durable handoff so auditors stop hitting a missing path. It was explicitly **not**
a mandate to redo or broaden the work.

## 2. What the change does

One feature, touching `src/providers/agent-status-tree-provider.ts` plus two test files.
It teaches the Agent Status tree to render an **honest "detached" state** for a `running`
lane whose live work Command Central cannot substantiate — instead of the animated
`sync~spin` spinner that asserts work is happening *right now*.

Concretely:

- **New `AgentTask` fields** carrying launcher-projected, evidence-backed probes from the
  `lane_ref_update` envelope (ghostty-launcher `scripts/laneref-update-schema.json`):
  - `launcher_attach_available` / `launcher_attach_reason` — from `attach` (writer-host
    `tmux has-session` probe at emission). `false` ⇒ executor could not attach.
  - `launcher_visibility_degraded` / `launcher_visibility_reason` — from `visibility`
    (`degraded === true` ⇒ a visible-bundle lane could not confirm a focusable window).
- **New helper coercers** `asNullableBoolean` and `asRecord`.
- **`normalizeTask`** now ingests the four new fields (coercing via `asNullableBoolean` /
  `asString`, defaulting to `null` when absent).
- **`laneRefUpdateToTaskRecord`** maps `envelope.attach` / `envelope.visibility` into the
  new fields (these were previously dropped on ingest). It returns a raw
  `Record<string, unknown>`, which then flows through `normalizeTask` for coercion — so
  passing the raw `unknown` values through is type-sound by construction.
- **New exported predicate `isLivenessUnobservableRunningLane(task)`** — a *static*
  visibility judgement (not a lifecycle one). Returns `true` for a `running` lane when:
  launcher `attach.available === false`, **or** launcher `visibility.degraded === true`,
  **or** the structural fallback (a `lane_projection` row whose `session_id` fails
  `isValidSessionId` — a session-less projection with nothing to probe). Remote-node lanes
  are always excluded (host can't be verified locally — fail-open).
- **Rendering** (`createTaskItem` / `getTreeItem`): when
  `isLivenessUnobservableRunningLane(task)` **and** `!hasPositiveLivenessEvidence(task)`,
  the row swaps `sync~spin` for a static `debug-disconnect` icon (charts.yellow), appends
  `(detached)` to the description, and adds a `$(debug-disconnect) Liveness: Detached …`
  tooltip line (with the launcher's reason when present). The runtime liveness gate
  (`hasPositiveLivenessEvidence`) means a worktree-discovered live agent — or a
  launcher-flagged row CC can locally confirm alive — **keeps its spinner**. The row stays
  `running` and in its status group; only the icon/description become honest.

### Correctness assessment

Well-documented, internally consistent, type-sound:
- The `laneRefUpdateToTaskRecord` → `normalizeTask` flow means raw `unknown` envelope
  values are always re-coerced before they reach `isLivenessUnobservableRunningLane`.
- Absent `attach`/`visibility` ⇒ `undefined` ⇒ `?? null` ⇒ `null` ("not probed"), matching
  the documented schema semantics; only an explicit `false`/`true` triggers the badge.
- "Detached" is correctly modeled as a *visibility badge gated by the live probe*, not a
  lifecycle demotion — consistent with the existing Agent Status V2 doctrine
  (`agent-status-running-detached-surface.test.ts`: running + unconfirmable lanes stay in
  Current·Live, and a session POSITIVELY confirmed dead still demotes).

No bug, regression, or schema mismatch found. **No fix required.**

## 3. Accepted / fixed / reverted

**ACCEPTED.** This recovery lane made **no code change** and did **not** revert. The
underlying change is sound. During this lane's session the work was also *finalized* by a
sibling lane (see §5): the original `chore: auto-commit` placeholder `d80c4805` was
rewritten into the conventional commit `5ef4c4bd`
(`fix(agent-status): render detached truth for liveness-unobservable running lanes`),
which carries the identical logic plus biome formatting plus full test coverage. The
verdict is unchanged by the rewrite — same behavior, now properly committed and tested.

## 4. Tests run and results

Final, clean run against the committed feature state (HEAD `5ef4c4bd`, working tree
holding only this lane's untracked research docs):

| Gate | Result |
| --- | --- |
| `bunx tsc --noEmit` | ✅ exit 0 (clean) |
| `bunx biome check src/providers/agent-status-tree-provider.ts` | ✅ exit 0, "No fixes applied" |
| `bun test …agent-status-running-detached-surface + …worksystem-lanes-projection` | ✅ 26 pass / 0 fail (97 expect) |
| `bun test …read-registry + …rendering + …pure-helpers` | ✅ 98 pass / 0 fail |
| `just test-unit` | ✅ all subsets pass / 0 fail |
| `just check` | ✅ exit 0 — 8 **pre-existing** biome warnings, all in `test/tree-view/agent-status-perf-caches.test.ts` (`noNonNullAssertion`), unrelated and informational |

The eight `just check` warnings live in `agent-status-perf-caches.test.ts` (untouched by
this feature), so they predate this work. Earlier in the session, before the sibling
finalized, the detached-surface file alone passed 14/14; the finalized commit adds the
dedicated `isLivenessUnobservableRunningLane` + attach/visibility-ingest coverage (now
26/26 across the two feature test files).

## 5. Concurrent sibling lane — work finalized during this session (auditor context)

The shared working copy was driven by a **live concurrent sibling lane** that appeared
mid-session (initial `git status` was clean). Per the known "concurrent lane commit
sweep" hazard in this repo, this fixup lane deliberately did **not** touch or commit any
of the sibling's files, and staged only its own research docs by explicit path (never
`git add -A`).

Observed sequence:
1. Session start: tree clean, HEAD `d80c4805`.
2. Sibling began editing `agent-status-running-detached-surface.test.ts` (imports +
   `taskItemFor` / `iconIdOf` helpers), then `worksystem-lanes-projection.test.ts`, then a
   **cosmetic** biome reformat of the provider's nested ternary + `launcher_attach_reason`
   line-wrap (no logic change).
3. Sibling committed: HEAD moved to `5ef4c4bd`, rewriting the `d80c4805` placeholder into
   a proper `fix(agent-status): …` commit (`d80c4805`'s parent `ff4a097e` is now
   `5ef4c4bd`'s parent — the placeholder was reset/amended away; the `d80c4805` object
   still exists in the object store, off-branch).
4. `5ef4c4bd` net diff vs `ff4a097e`: +477 lines across the provider and the two test
   files — i.e. the original logic + formatting + comprehensive tests + a real commit
   message. Strictly a superset of `d80c4805`.

Net effect: the feature is now properly committed and tested, and this lane's review
applies verbatim to the finalized commit (the logic is identical).

## 6. Remaining dogfood blockers

- **Installed-VSIX live proof not performed.** The original task name implies an
  installed-VSIX dogfood proof (build → install → observe the `(detached)` rendering in a
  running VS Code). This lane's rules forbid push/tag/publish/**install a VSIX**, so the
  live installed proof is intentionally out of scope. Verification here is static +
  unit/integration-level only. A human (or an authorized release lane) should still do the
  live installed-VSIX dogfood pass to confirm the spinner→`debug-disconnect` swap renders
  as intended on a real launcher `lane_ref_update` carrying `attach`/`visibility`.
- The dedicated unit/integration coverage that `d80c4805` originally lacked **now exists**
  (added in `5ef4c4bd`), so that earlier gap is closed.

## 7. Final git status and HEAD

- **HEAD:** `5ef4c4bd` — `fix(agent-status): render detached truth for liveness-unobservable running lanes`
  (this fixup lane's docs commit lands on top; see updated HEAD after commit).
- **Superseded:** `d80c4805` — `chore: auto-commit agent work [cc-installed-vsix-dogfood-proof-20260614]`
  (object still present, off-branch).
- **This lane's committed change:** two research markdown files only —
  `research/RESULT-cc-installed-vsix-dogfood-proof-fixup-20260614.md` (this file) and
  `research/RESULT-cc-installed-vsix-dogfood-proof-20260614.md` (alias/summary so the
  originally-missing path resolves).
- **Working tree:** clean apart from these two research docs, which this lane commits. No
  stray or swept changes.

---

### Bottom line

The change is a correct, type-safe, regression-free improvement that makes "running"
rows stop implying work CC can't observe. The prior lane's only failure was the missing
handoff — now supplied. During this session the work was also finalized (`d80c4805` →
`5ef4c4bd`) with full test coverage and a proper commit message. No code was changed or
reverted by this recovery lane. The only remaining dogfood gap is the live installed-VSIX
visual proof, which is out of scope for this no-publish fixup lane.
