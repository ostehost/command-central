# Command Central — Next-RC Readiness Prep (after rc.66)

- **Task id:** `cc-next-rc-prep-20260616`
- **Date:** 2026-06-16
- **Role:** release-readiness / preflight engineer
- **Machine:** `ostehost@MacBookPro` (node — Mike MacBook Pro; satisfies the node-execution guard)
- **Repo:** `/Users/ostehost/projects/command-central` @ branch `main`
- **Scope:** local only. **No publish / push / tag / GitHub release / version bump.**
- **Outcome:** ✅ The current tree is **RC-ready on demand** — all standard gates green, including the *repaired* installed-VSIX proof. A new RC (rc.67) is **intentionally not cut**: there is **no shippable delta** since the rc.66 cut, so cutting now would be version-only churn. Readiness is verified; the cut is deferred until a shippable change lands.

---

## 1. HEAD / version — before and after

| | Value |
| --- | --- |
| **HEAD before this task** | `820d1d35` docs(research): record installed-VSIX proof substring false-positive fix |
| **HEAD after this task** | this `docs(research):` commit layered on `820d1d35` (see §6) |
| **Version before** | `0.6.0-rc.66` |
| **Version after** | `0.6.0-rc.66` (**unchanged** — no cut, `package.json` untouched) |

`main` remains local-only, **59 commits ahead of `origin/main`**. No tags, no publish.

---

## 2. Why no rc.67 cut (the central readiness judgment)

The only **substantive** commit since the rc.66 cut commit (`cc783b4f`) is:

```
d742777a fix(test): boundary-safe forbidden task-id matching in installed-VSIX proof
```

That commit touches **only** the release-gate proof harness
(`test/integration/installed-vsix-proof-shared.ts` + its test) — **zero `src/`
changes**. It therefore ships **nothing** in the packaged extension: an rc.67
VSIX would be functionally identical to rc.66's shipped `extension.js`,
differing only by the embedded version string.

The remaining post-rc.66 commits (`dd25b8a7`, `820d1d35`, and this one) are
`docs(research):` — release-process noise, not product changes.

**Conclusion:** cutting rc.67 right now is *permitted* (it is the standard safe
local step and all tests are green) but would be **a no-delta version bump**. The
honest, higher-value call is to **verify readiness now** and **defer the cut**
until the next shippable change lands. This is consistent with the task's
"smallest valuable next-RC prep item" framing — the valuable slice here is
*proving* readiness and correcting the readiness record, not manufacturing a
churn RC.

When the next shippable change does land, `just cut-preview` will produce rc.67
and its digest's *"Since previous prerelease cut (rc66)"* section will correctly
resolve its base to `cc783b4f` and list the real delta (verified by reading
`scripts-v2/release-digest.ts` `resolvePreviousCutBase` and by running the
digest tool live — §3).

---

## 3. Gates run — exact commands and results

All commands run on node (`ostehost@MacBookPro`); read-only with respect to git,
the live launcher registry, and any external service.

| # | Command | Result |
| --- | --- | --- |
| 1 | `just check` (Biome ci + tsc + knip) | ✅ **0 errors**. "Checked 290 files in 308ms. Found **8** warnings" — the pre-existing informational knip/biome warnings, unchanged by this task. Exit 0. |
| 2 | `just test` (full suite + quality gate) | ✅ **2188 pass / 0 fail / 1 skip** (2189 ran) across 153 files in 18.67s. Quality gate ✅ (zero `as any`, zero reflection, zero skips). Exit 0. |
| 3 | `bun run scripts-v2/node-execution-guard.ts` | ✅ `node-execution-ok` |
| 4 | `just test-installed-vsix-agent-status --vsix releases/command-central-0.6.0-rc.66.vsix` | ✅ `installed-vsix-agent-status-proof-ok`. VS Code 1.124.2. Exit 0. (detail below) |
| 5 | `just preview-status` | ✅ rc.66 lifecycle record reads `succeeded`, exit code 0, artifact sha `154643ac…` |
| 6 | `bun run scripts-v2/release-digest.ts --format discord` | ✅ Exit 0 — digest pipeline healthy; base resolves correctly to the previous cut |

### Installed-VSIX proof detail (the repaired RC proof gate)

```
phase: quarantine-default
  version: 0.6.0-rc.66
  task count: 222
  forbidden launcher hits: 0      ← repaired matcher holds
  expected ids visible: 0/0
phase: legacy-fixture
  version: 0.6.0-rc.66
  task count: 224
  forbidden launcher hits: 0
  expected ids visible: 2/2        ← legacy fixture ids still discovered
Exit code: 0
```

This is a **genuine** re-validation, not a vacuous pass: the live registry still
contains the original triggering residue (`ghostty-project-ref-laneref-20260611`
and its lane-backed `review-…` derivative), and the task count has grown to
**222/224** (up from 218/220 at the substring-fix commit), so the proof ran
against *current* live data and the boundary-safe matcher (`d742777a`) still
reports **0 forbidden hits**.

---

## 4. What changed in this task

Two files, both documentation / readiness-record accuracy — **no `src/` and no
shipped behavior changed**:

| File | Change |
| --- | --- |
| `research/CC-NEXT-VERSION-PREFLIGHT-2026-06-16.md` | Added a clearly-marked **✅ RESOLVED** status note to §5 **R1**. R1 had documented the installed-VSIX proof substring false-positive as an *open* risk and recommended a follow-up "tighten the forbidden sweep" — that follow-up was completed in `d742777a`. The note points to the fix and this readiness doc; the original point-in-time analysis is retained unchanged below the note. |
| `research/CC-NEXT-RC-PREP-2026-06-16.md` | This readiness record. |

Rationale for the R1 edit: the most recent preflight doc is what an operator
consults before the next cut. Leaving a stale *"open risk / follow-up pending"*
on a risk that is in fact resolved would mislead that operator into distrusting
the (now trustworthy) installed-VSIX proof gate. The edit corrects the record
without rewriting the original analysis.

---

## 5. Can the next RC be cut now? / What remains

**Yes — rc.67 can be cut on demand; nothing is blocking it.** All gates are
green and `just cut-preview` is the documented, local-only standard step
(preflight → sync-launcher → CI rehearsal → prerelease gate → `dist --prerelease`).

**Recommendation: defer the cut.** There is no shippable delta since rc.66 (§2),
so a cut today buys only a version-string bump. Cut rc.67 when the next
product-facing change lands; readiness is already proven, so that cut should be
frictionless.

Non-blocking notes carried forward (none gate the next RC):

- **N1 — local-only / unpushed.** `main` is 59 ahead of `origin/main` (the
  long-standing local working state). Push/tag/publish are Tier 2 and remain
  operator-driven — intentionally not done here.
- **N2 — reload to activate.** Already-open VS Code windows run the previously
  active build until **Developer: Reload Window** (standard for an install over
  a running instance).
- **N3 — launcher-registry residue (optional hygiene).** The completed
  `ghostty-project-ref-laneref-20260611` / `review-…` rows still sit in the live
  launcher registry. The repaired proof is robust to this residue (0 hits), so
  reaping it is optional launcher-owned hygiene, not a CC release gate.
- **N4 — digest will surface `d742777a` under "Since rc66".** When rc.67 is
  cut, its digest's git-derived section will list the test-harness commit (only
  `chore(release):`/`docs(research):` subjects are filtered as noise). Accurate,
  if slightly internal; not worth changing the noise filter for a single RC.

---

## 6. Commit

Staged **path-scoped** (no `git add -A`) to avoid sweeping any sibling-lane
edits into this commit (working tree was clean before staging; verified again
after):

```
git add -- research/CC-NEXT-VERSION-PREFLIGHT-2026-06-16.md \
            research/CC-NEXT-RC-PREP-2026-06-16.md
git commit -m "docs(research): record next-RC readiness checkpoint (rc.66) + resolve R1"
```

The Biome pre-commit hook ran and passed (no `--no-verify`).

---

## 7. Constraint compliance

| Constraint | Status |
| --- | --- |
| No marketplace publish | ✅ none |
| No push | ✅ none |
| No git tag | ✅ none |
| No GitHub release | ✅ none |
| No version bump / no cut | ✅ `package.json` untouched at `0.6.0-rc.66` |
| No external / live-registry mutation | ✅ all gates read-only; launcher registry untouched |
| Preserve existing work (no reset/rebase/discard) | ✅ history intact; 59-ahead state preserved |
| No `--no-verify` | ✅ Biome pre-commit hook ran and passed |
| Path-scoped staging (sibling-lane safety) | ✅ only the two research docs staged |

**Explicit statement:** **No external release, push, tag, or publish occurred.**
This task was local verification + a documentation-accuracy correction only.

---

## 8. Suggested next steps for the operator

1. When the next shippable change lands, run `just cut-preview` to cut rc.67 —
   readiness is already proven, so it should pass cleanly.
2. After any cut, **Developer: Reload Window** + `just verify-vscode-consumption`
   + `just preview-status` (expect `succeeded`).
3. (Optional) Reap the 2026-06-11 launcher-registry residue as routine hygiene
   (launcher-owned; not required for the proof to pass).
4. Push/tag/publish remain operator-driven (Tier 2) — not performed here.
