# Review — `cc-performance-next-rc-20260616` (provider-overload recovery)

- **Review task id:** `review-cc-performance-next-rc-20260616-provider-overload-recovery`
- **Date:** 2026-06-16
- **Mode:** read-only review; working tree left untouched (commit preserved, no edits)
- **Subject commit:** `999ce6d4` — `perf(agent-status): bounded tail read for stream terminal-state detection`
- **Repo:** `/Users/ostehost/projects/command-central` @ `main` (ahead of `origin/main` by 61; **unpushed**)
- **Implementation lane:** `cc-performance-next-rc-20260616` (hit `API Error: Overloaded` mid-work)

## Verdict

**ACCEPTABLE — ship as-is.** No fixup required, no revert warranted.

The commit is a correct, well-scoped, well-tested hot-path performance improvement
with exact behavior preservation for all real inputs and graceful degradation for
pathological ones. Scope constraints (no publish / tag / version bump) are honored.
The provider-overload recovery **succeeded**: the agent's work was committed to a
clean tree and the completion/review artifacts were subsequently produced. The
"no receipt" condition in the task premise was a **transient, self-healed** window
(see §5), not a lost result.

- **Blockers:** none
- **Warnings:** 2 (orchestration/recovery, not code) — see §5/§6
- **Nits:** 1 (an unreachable edge that degrades to `null`, not to wrong data) — see §3

---

## 1. Scope review (intended: perf/polish toward next RC; no publish/tag/version bump)

`git show --stat 999ce6d4 --format=`:

```
 research/CC-PERFORMANCE-NEXT-RC-2026-06-16.md   | 217 +++++++++++++++++
 src/providers/agent-status-tree-provider.ts     |  70 +++++-
 test/tree-view/agent-status-perf-caches.test.ts | 123 ++++++++++
 3 files changed, 404 insertions(+), 6 deletions(-)
```

| Constraint | Evidence | Status |
| --- | --- | --- |
| No version bump / no cut | `package.json` **not** in the diff; version at `999ce6d4` and in the working tree both `0.6.0-rc.66` | ✅ |
| No marketplace publish / release artifact | No `releases/`, `*.vsix`, `CHANGELOG`, or `package.json` in the diff | ✅ |
| No tag created by this commit | No version/release/changelog files touched ⇒ no publish performed as part of the commit. **`git tag --points-at` was NOT run** — it triggered an approval prompt and was deliberately skipped per operator instruction. Tag-absence is therefore *inferred* from the changed-file set, not positively verified. | ✅ (inferred) |
| Product (`src/`) delta present | `src/providers/agent-status-tree-provider.ts` carries a real behavior-relevant change — exactly the shippable delta the rc.66 prep doc flagged as missing | ✅ |
| Working tree clean post-commit | `git status --porcelain` empty (only `## main...origin/main [ahead 61]`) at review start | ✅ |
| Documentation-only research file | `research/CC-PERFORMANCE-NEXT-RC-2026-06-16.md` is a self-contained engineering note; no self-certified completion of external systems | ✅ |

The change is squarely on-scope: a single hot-path performance fix plus tests plus a
research note. No scope creep, no external mutation.

---

## 2. What the commit does

`_computeStreamTerminalState()` (called per **running** task from
`toDisplayTask()` → `getStreamTerminalState()`, a 5 s-TTL hot path) previously read
the **entire** agent JSONL stream file and allocated an array of every line just to
take the last non-empty one:

```ts
fs.readFileSync(streamFile, "utf-8").split("\n").map(trim).filter(nonEmpty).at(-1)
```

Stream files grow without bound while a task runs (multi-MB for long sessions), and
this read fires on every launcher `tasks.json` write plus the 30 s auto-refresh — so
the cost was `O(total stream bytes)` of synchronous main-thread I/O, scaling with how
long agents have been running. The commit replaces it with a bounded **tail read**:

- new static `STREAM_TAIL_BYTES = 64 * 1024`
- `readLastNonEmptyStreamLine(streamFile)` — small files (≤ 64 KiB) read in full
  (unchanged); larger files read only the final 64 KiB
- `readFileTailUtf8(path, size, tailBytes)` — `openSync` → positioned `readSync` of
  the last 64 KiB → `closeSync` (fd closed in `finally`)

The fast path adds one `O(1)` `statSync` and eliminates the `O(file size)` read +
array allocation. Public surface and all callers are unchanged.

---

## 3. Correctness analysis (adversarial)

Verified the result is identical to the original full read for all realistic inputs,
with safe degradation for the rest:

- **Normal stream (ends with `{event}\n`):** the last 64 KiB always contains the final
  complete event line; `split("\n")` → last non-empty → identical to the full read. ✅
- **Window starts mid-line / mid-UTF-8 sequence:** the leading partial fragment (and any
  replacement char from a split multibyte codepoint at the window start) is in the
  **first** line, which is discarded — only the **last** non-empty line is returned. ✅
- **Oversized final line, no newline in window (>64 KiB single line):** `!content.includes("\n")`
  → full-read fallback → parses exactly as before. ✅ (test #4)
- **All-blank tail window (real line pushed past 64 KiB by trailing blanks):**
  `content.trim().length === 0` → full-read fallback recovers the earlier real line. ✅ (test #3)
- **Empty file (size 0):** `0 ≤ 64 KiB` → full read → `""` → returns `null`, same as before. ✅
- **stat/read race (file rotated, shrunk, or deleted between `statSync` and read):**
  short read uses `bytesRead`; a missing file throws in `openSync` → caught by the outer
  `try/catch` in `_computeStreamTerminalState` → `null` — identical failure mode to the
  original `readFileSync`. ✅
- **No fd leak:** `readFileTailUtf8` closes the descriptor in `finally`. ✅

**NIT (unreachable for real streams; degrades to `null`, never to wrong data):**
A single final content line **larger than 64 KiB** that is **followed by trailing
blank line(s)** slips past *both* fallbacks — the window then contains a truncated tail
of the big line plus trailing `\n`s, so `content.includes("\n")` is true *and*
`content.trim()` is non-empty. The function would return the **truncated** tail of that
line. Consequence is benign: `JSON.parse` on a mid-string truncation throws → caught →
`getStreamTerminalState` returns `null` → the classifier falls back to health checks
(graceful "unknown", not a misclassification or crash). This shape requires both an
event >64 KiB *and* trailing blank lines at EOF, which does not occur for real agent
JSONL streams (they end at the latest event line). Not worth fixing for this RC;
recorded for completeness. If ever hardened, the fallback predicate could also trip
when the window's first line lacks a leading newline boundary.

No correctness defect that affects real inputs. Behavior preservation holds.

---

## 4. Test & gate verification (re-run locally, hub)

| Gate | Result |
| --- | --- |
| `bun test test/tree-view/agent-status-perf-caches.test.ts` | ✅ **22 pass / 0 fail** (35 expect calls; 5 new tail-read tests) |
| `bun test test/tree-view/` | ✅ **540 pass / 0 fail** across 27 files (1.58s) |
| `just check` (biome ci + tsc + knip) | ✅ **exit 0**; 8 informational warnings, **all pre-existing** (`noNonNullAssertion` at test lines 185/190/219/224/322/327/358/363 — all *outside* the commit's added ranges of src 1482–2828 and test 610+). The commit introduced **zero** new warnings. |
| `just test` (full suite + quality gate) | ✅ **2194 pass / 0 fail / 1 skip** (153 files, 17.48s); quality gate ✅ (0 `as any`, 0 reflection, 0 skipped) |

Notes:
- The 5 new tests use real `node:fs` + real tmp files and cover small / large /
  blank-tail-fallback / oversized-line-fallback / end-to-end (`getStreamTerminalState`
  resolves `completed` from a large file). Good shape coverage.
- The tests intentionally do **not** assert that I/O is bounded — the harness's
  `node:fs` namespace mock makes fd-level spying unreliable, so the bounded-read
  property is guaranteed structurally (code review) rather than via a brittle/false
  spy. The research note is honest about this trade-off. Acceptable.
- The combined nit case in §3 is the one shape not pinned by a test (consistent with it
  being unreachable for real streams).
- Commit message claims "2193 pass"; local re-run shows 2194 pass / 1 skip. The delta is
  immaterial (one environment-dependent skip / a since-added test) and the suite is green.

---

## 5. Recovery-gap assessment (the dogfooding focus)

**Premise (as handed to this review):** the lane hit `API Error: Overloaded`, yet
`999ce6d4` was committed to a clean tree; the launcher task still read *running* and
`/tmp/oste-pending-review/cc-performance-next-rc-20260616.json` did **not** exist.

**Observed at review time — the receipt now exists.** Reconstructed timeline:

| Time (EDT) | Event | Source |
| --- | --- | --- |
| 16:35:26 | commit `999ce6d4` authored (clean tree) | `git show -s` |
| 16:36:17 | `/tmp/oste-complete-cc-performance-next-rc-20260616` written — `status=completed`, `exit_code=0`, `exec_host=Mike's MacBook Pro` | marker mtime + body |
| 16:36:17 | receipt `completed_at: 2026-06-16T20:36:17Z` | receipt body |
| 16:36:27 | `/tmp/oste-pending-review/cc-performance-next-rc-20260616.json` written; `review_started_at: 20:36:27Z`, `review_dispatch_attempts: 1`, `review_state: reviewing` | receipt mtime + body |

**Conclusion: the recovery succeeded and the gap self-healed.** Despite the overload,
the agent's work was *not* lost — it committed cleanly, and the finalizer subsequently
(a) wrote the completion marker, (b) wrote the pending-review receipt
(`status: completed`, `exit_code: 0`, all four commit fields = `999ce6d4`,
`tests_passing: true`), and (c) dispatched a canonical review. The premise snapshot was
simply captured *inside* the ~51 s window between the commit (16:35:26) and finalization
(16:36:17) — during which a clean committed tree legitimately exists with no completion
receipt yet, and the launcher task reads as still-running.

Whether the overload *lengthened* that finalization window cannot be determined from
the artifacts alone: ~51 s between commit and the complete marker is also consistent
with ordinary post-commit finalization latency (final summary → Stop hook → artifact
write). What is verifiable: the recovery did not drop, duplicate, or corrupt the commit.

---

## 6. Warnings (orchestration / recovery — not code defects)

**W1 — Duplicate review dispatch for one commit.** Two distinct review tasks now exist
for `999ce6d4`:
1. the canonical finalizer-dispatched review `review-cc-performance-next-rc-20260616`
   (handoff `/tmp/command-central-cc-performance-next-rc-20260616-review/research/REVIEW-cc-performance-next-rc-20260616.md`,
   `review_backend: project-app`, `review_mode: canonical-committed`, dispatched 16:36:27); and
2. **this** recovery review `review-cc-performance-next-rc-20260616-provider-overload-recovery`
   (handoff `research/REVIEW-cc-performance-next-rc-20260616-provider-overload-recovery.md`),
   launched on the stale "no receipt" premise.

Both are read-only, so there is no integrity risk — but the recovery path and the normal
finalizer both fired for the same commit. A robust provider-overload-recovery mechanism
should re-check for a finalizer-produced receipt before (or instead of) dispatching its
own review, and ideally reconcile/merge the two rather than run duplicate review effort.

**W2 — Receipt may be stuck in `review_state: reviewing`.** The receipt shows
`review_state: "reviewing"`, `reviewed: false`, `review_completed_at: null` since
16:36:27. If the canonical review (W1.1) never reaches a terminal state, the receipt
remains "reviewing" indefinitely. This review (W1.2) writes to a *different* handoff
path and a *different* task id, so completing it will **not** close the canonical
receipt. Operator should confirm the canonical review either completed or is reconciled,
so the task does not linger half-reviewed. (Not verifiable from within this read-only
review without inspecting the canonical review's terminal state.)

---

## 7. Recommendation

- **Implementation:** accept `999ce6d4` as-is. No fixup, no revert. Optional follow-up
  perf slices already noted by the author (drop the discarded `git log -1` spawn in
  `getCompactChildren`; bound the `readDiscoveredPrompt` JSONL fallback) — separate tasks.
- **RC:** a genuine shippable `src/` delta now exists; cutting rc.67 via
  `just cut-preview` remains the operator's call (Tier 2). Push/tag/publish stay
  operator-driven and were not performed.
- **Recovery mechanism:** address W1/W2 in the launcher/finalizer — de-duplicate review
  dispatch against a later-arriving finalizer receipt, and ensure the canonical receipt
  reaches a terminal `reviewed` state.

---

## Method / limitations

- Read-only review; no edits to tracked files, commit preserved.
- `git tag --points-at 999ce6d4` and filesystem `find`/`grep` over launcher registries
  were **skipped** because they triggered approval prompts; per operator instruction the
  no-tag/no-publish conclusion is **inferred** from the commit's changed-file set (no
  version/release/changelog/vsix files), not positively verified against the tag list or
  the live launcher `tasks.json`.
- Gate results above are from local re-runs on the hub at review time.
