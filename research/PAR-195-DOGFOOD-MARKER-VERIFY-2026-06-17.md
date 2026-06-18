# PAR-195 — Dogfood Marker: Verification of Already-Shipped Symphony-Lane Attention Fix

- **Task id:** `symphony-PAR-195-25b2b85f`
- **Linear item:** [PAR-195](https://linear.app/partnerai/issue/PAR-195/agent-status-should-not-surface-completed-detached-symphony-lanes-as) — *Agent Status should not surface completed detached Symphony lanes as ambiguous attention-required rows*
- **Lane:** `symphony-PAR-195-25b2b85f` (visible Claude Code implementation lane launched by the Symphony daemon)
- **Date:** 2026-06-17
- **Machine:** Mike's MacBook Pro (`MacBookPro`, user `ostehost`)
- **Repo:** `/Users/ostehost/projects/command-central` @ branch `main`
- **Scope:** local only, docs-only. No source/tests/config/version touched, no push / tag / publish / marketplace release / external writes / destructive reset.
- **Outcome:** PAR-195 was **already implemented, tested, and documented** by the prior lane `symphony-PAR-195-19fde801`. This second lane re-verified the shipped fix end-to-end and records the dogfood provenance for `symphony-PAR-195-25b2b85f`.

---

## 1. Why this marker exists (and what it is *not*)

PAR-195's behavior change already landed on `main` before this lane started:

| Commit | What |
| --- | --- |
| `515e1321` | `feat(agent-status)`: `isSymphonyLane()` predicate + Symphony branch in `classifyCompletionRouting()` + `&& !isSymphonyLane(task)` badge guard |
| `3ea8bb31` | `test(agent-status)`: 18-test suite `test/tree-view/agent-status-symphony-detached.test.ts` |
| `d2c16143` | `docs(research)`: `research/PAR-195-COMPLETED-DETACHED-SYMPHONY-LANE-2026-06-17.md` (the primary implementation handoff) |

So there was **no remaining source change to make** — re-implementing it would only churn already-correct, already-tested code. The honest, smallest-safe deliverable for this subsequent lane is a verification marker: confirm the shipped fix is still present and green, and leave a tracked provenance artifact. This is **not** a re-implementation and does not re-claim that work; the primary handoff doc remains `PAR-195-COMPLETED-DETACHED-SYMPHONY-LANE-2026-06-17.md`.

## 2. What this lane verified

**Code still in place (read-only inspection):**

- `src/providers/agent-task-classification.ts`
  - `isSymphonyLane(task)` exported predicate — matches `^symphony-` launcher id OR `orchestration_mode === "symphony"` (trimmed, case-insensitive).
  - `classifyCompletionRouting()` terminal branch — Symphony case returns `kind:"detached"` / `label:"Detached — orchestrated (no action needed)"` / `iconColor:"disabledForeground"` (muted, not `charts.yellow` attention), placed after the reviewer case and before the generic "manual observation required" fallback.
- `src/providers/agent-status-tree-provider.ts`
  - `isSymphonyLane` imported and re-exported for import-site stability.
  - `⚠ detached` badge condition carries the `&& !isSymphonyLane(task)` guard, so a completed Symphony lane row gets no attention glyph.

**Tests green:**

```
bun test test/tree-view/agent-status-symphony-detached.test.ts   # 18 pass / 0 fail (32 expect() calls)
```

The `fatal: cannot change to '/tmp/project'` and `has no tasks file configured` lines in the test output are benign stderr from the mocked task's non-existent dir; all assertions pass.

## 3. Full-circle dogfood path proven

| Step | What happened |
| --- | --- |
| 1. Selection | Symphony daemon selected **PAR-195** (Command Central project). |
| 2. Routing | Routed to this visible Claude Code implementation lane (`symphony-PAR-195-25b2b85f`). |
| 3. Finding | The requested fix was already shipped by lane `symphony-PAR-195-19fde801`; nothing left to implement. |
| 4. Verification | This lane re-ran the 18-test suite (all pass) and confirmed the predicate, routing branch, and badge guard are present. |
| 5. Artifact | This committed `research/` marker proves the full-circle path reached Command Central and closes with a tracked commit — and, fittingly, *this* completed Symphony lane is exactly the kind of row PAR-195 ensures no longer reads as an ambiguous yellow `⚠ detached`. |

## 4. Change made

- **Added:** `research/PAR-195-DOGFOOD-MARKER-VERIFY-2026-06-17.md` (this file).
- **Nothing else touched.** No source, tests, config, packaging, or version bump. Matches the repo's `research/` convention (uppercase-kebab-case, dated, committed with a `docs(research):` message), mirroring the established PAR-189 / PAR-191 / PAR-193 dogfood-marker practice.

## 5. Constraints honored

- No publish, push, tag, marketplace release, external writes, or destructive reset.
- No Symphony/OpenClaw/launcher config touched; no `tasks.json` write.
- `git status --porcelain` clean after commit.
- Conventional commit; hooks honored (no `--no-verify`).
