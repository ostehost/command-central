# Command Central — Installed-VSIX Proof Substring False-Positive Fix

- **Task id:** `cc-installed-proof-substring-fix-20260616`
- **Date:** 2026-06-16
- **Role:** implementation engineer (release-gate proof reliability)
- **Machine:** `ostehost@MacBookPro` (node-execution guard: `node-execution-ok`)
- **Repo:** `/Users/ostehost/projects/command-central` @ branch `main`
- **Scope:** local only. No push / tag / publish / release / version bump.
- **Outcome:** ✅ Substring false-positive fixed. The passive installed-VSIX
  Agent Status proof now **passes both phases** against the live registry that
  still contains the original triggering residue.

---

## 1. HEAD

| | Commit |
| --- | --- |
| **Before this task** | `dd25b8a7` docs(research): record next-version preflight + rc.66 cut/proof |
| **Fix commit** | `d742777a` fix(test): boundary-safe forbidden task-id matching in installed-VSIX proof |
| **Handoff commit (this doc)** | committed on top as `docs(research): …` (see §6) |

`main` remains local-only and ahead of `origin/main`. No tags, no publish.

---

## 2. Root cause

`test/integration/installed-vsix-proof-shared.ts` → `nodeMatchesTaskId` matched
a task id against a tree node label with a **substring** test:

```ts
if (node.label.includes(taskId)) return true;
```

The forbidden-id sweep (`collectLauncherAttributedTaskIdHits`) derives
`quarantineForbiddenIds` from stale launcher-era rows (records with no
`project_ref`). The stale base id `ghostty-project-ref-laneref-20260611` lands
on that list. A **distinct, legitimate** lane id
`review-ghostty-project-ref-laneref-20260611` carries a valid `project_ref` and
surfaces correctly as a launcher `task` node with label
`🧊 🔍 review-ghostty-project-ref-laneref-20260611`.

Because the stale base id is a **substring** of the review lane label,
`label.includes(...)` reported the legitimately-surfaced review lane as the
forbidden id leaking back in — a false quarantine breach. This is a release-gate
**proof fragility**, not a product regression: the same assertion would fire on
rc.65 against today's live registry; no shipped quarantine/admission path is
affected.

---

## 3. The fix

Replaced the substring test with a **boundary-safe token matcher**,
`labelContainsTaskIdToken(label, taskId)` (exported for direct unit testing):

- The id must occur in the label delimited by a **non-id-token character**
  (or a string boundary) on each side.
- Id-token characters are `[A-Za-z0-9_-]` — crucially including `-`/`_`, the
  characters that glue derivatives onto a base id.
- Consequence: `review-<id>`, `<id>-review`, and `retry_<id>_2` are recognized
  as parts of a **larger** id token and rejected, while `<id>` still matches
  when it surfaces on its own (after an emoji, after a space, standalone, or at
  the end of a label).
- Uses literal `indexOf` scanning (not a `RegExp` built from the id), so there
  is no regex-escaping concern for arbitrary ids.
- The structured exact path — `node.ownerFields.taskId === taskId` — is
  unchanged, so genuine structured matches are unaffected.

`nodeMatchesTaskId` now calls `labelContainsTaskIdToken` first, then falls back
to the exact `ownerFields.taskId` comparison. Both consumers
(`collectLauncherAttributedTaskIdHits` — the forbidden sweep, and
`collectTaskIdPresence` — expected-id discovery) inherit the safe behavior.

### Files changed

| File | Change |
| --- | --- |
| `test/integration/installed-vsix-proof-shared.ts` | Added `labelContainsTaskIdToken` + `isIdTokenChar` (boundary-safe matcher); `nodeMatchesTaskId` now uses it instead of `label.includes`. |
| `test/integration/installed-vsix-proof-harness.test.ts` | New `describe("boundary-safe task id matching")` block (5 tests) + import of `labelContainsTaskIdToken`. |

No `src/` (shipped extension) code changed — the defect lived entirely in the
release-gate proof harness.

---

## 4. Tests run

### Focused (unit, `bun:test`)
```
bun test test/integration/installed-vsix-proof-harness.test.ts
→ 20 pass / 0 fail / 66 expect() calls
```
New cases prove:
1. **Exact stale id still matches when truly present** — standalone, after one
   emoji, after two emoji, and at end-of-label.
2. **`review-<id>` (and `<id>-review`, `retry_<id>_2`) do not false-positive.**
3. **Forbidden sweep ignores a lane-backed `review-<id>` node** (reproduces the
   rc.66 manifest false-positive scenario) → `hits === []`.
4. **Forbidden sweep still catches the stale id when it genuinely surfaces**
   alongside the review derivative → exactly one hit on the real id.
5. **Ordinary task-id presence detection is unaffected** (including ids that
   surface only via `ownerFields.taskId`).

### Full suite (`just test`)
```
2188 pass / 1 skip / 0 fail / 6016 expect() calls across 153 files (18.6s)
Test-quality gate: ✅ (zero `as any`, zero reflection, zero skips)
```
(+5 over the rc.66 preflight baseline of 2183 — exactly the new boundary-safe
tests.)

### Read-only gate (`just check`)
```
Biome ci + tsc + knip → ✅ Checks complete (8 pre-existing informational
knip/biome warnings, unchanged by this task; 0 errors).
```

### Live installed-VSIX proof (`just test-installed-vsix-agent-status`)
Rerun **passively** against real VS Code (test-electron) and the **live**
registries — which still contain the original triggering residue
(`ghostty-project-ref-laneref-20260611` *and*
`review-ghostty-project-ref-laneref-20260611`), so this is a genuine validation,
not a vacuous pass:

```
just test-installed-vsix-agent-status --vsix releases/command-central-0.6.0-rc.66.vsix

installed-vsix-agent-status-proof-ok

phase: quarantine-default
  version: 0.6.0-rc.66
  task count: 218
  forbidden launcher hits: 0      ← was 1 (the review-<id> false-positive); now 0
  expected ids visible: 0/0
phase: legacy-fixture
  version: 0.6.0-rc.66
  task count: 220
  forbidden launcher hits: 0
  expected ids visible: 2/2        ← legacy fixture ids still discovered; no regression
Exit code: 0
```

The forbidden-hit count dropped from 1 → 0 precisely because the review lane is
no longer misread as the forbidden base id, while the legacy fixture ids
(`installed-proof-legacy-alpha/beta`) still surface 2/2.

---

## 5. Does the passive installed-VSIX proof now pass?

**Yes — fully, and not externally blocked.** Both phases report
`installed-vsix-agent-status-proof-ok` with exit code 0 on this node against the
live registry. The R1 risk from `CC-NEXT-VERSION-PREFLIGHT-2026-06-16.md` §5 is
resolved at the proof layer.

Note: the live launcher registry **still** holds the stale/`review` residue from
2026-06-11. Reaping that residue (`~/.config/ghostty-launcher/tasks.json`) is a
separate launcher-owned hygiene task and was intentionally **not** done here —
the fix makes the proof robust to such residue rather than depending on its
absence. No live registry was mutated by this task.

---

## 6. Release implications

- **No version bump, no new cut.** rc.66 (`0.6.0-rc.66`) stands; `package.json`
  untouched. The fix is test-harness-only and ships nothing in the VSIX.
- The passive installed-VSIX Agent Status proof can again be **trusted as a
  release gate** — it no longer false-fails on lane-backed derivatives of stale
  ids.
- No push / tag / marketplace publish / GitHub release performed. `main` remains
  local-only and ahead of `origin/main`.
- Recommended next step (operator/separate task): optionally reap the completed
  `ghostty-project-ref-laneref-20260611` / `review-…` residue from the live
  launcher registry as routine hygiene — no longer required for the proof to
  pass.

---

## 7. Commands run (in order)

| Command | Result |
| --- | --- |
| Read proof shared/runner/suite + harness test + preflight doc | root cause confirmed at `installed-vsix-proof-shared.ts` `nodeMatchesTaskId` |
| Edit `installed-vsix-proof-shared.ts` (boundary-safe matcher) | ✅ |
| Edit `installed-vsix-proof-harness.test.ts` (+5 tests) | ✅ |
| `bun test test/integration/installed-vsix-proof-harness.test.ts` | ✅ 20 pass |
| `just fix` (Biome format) | ✅ 1 file formatted |
| `just check` | ✅ 0 errors |
| `just test` | ✅ 2188 pass / 1 skip / 0 fail + quality gate |
| `bun run scripts-v2/node-execution-guard.ts` | ✅ `node-execution-ok` |
| `just test-installed-vsix-agent-status --vsix …rc.66.vsix` | ✅ both phases ok, 0 forbidden hits |
| `git add -- <two proof files>` + `git commit` | ✅ `d742777a` (Biome hook passed) |

## 8. Constraint compliance

| Constraint | Status |
| --- | --- |
| No push | ✅ |
| No tag | ✅ |
| No marketplace publish | ✅ |
| No GitHub release | ✅ |
| No version bump | ✅ |
| No live-registry mutation | ✅ (read-only) |
| No `--no-verify` | ✅ Biome pre-commit hook ran and passed |
| Path-scoped staging (no `git add -A`) | ✅ only the two proof files staged |
