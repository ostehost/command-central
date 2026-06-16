# Command Central — Agent Status performance tune (toward next RC)

- **Task id:** `cc-performance-next-rc-20260616`
- **Date:** 2026-06-16
- **Role:** performance / user-visible-polish engineer (visible implementation agent)
- **Machine:** node — Mike MacBook Pro (`ostehost@MacBookPro`)
- **Repo:** `/Users/ostehost/projects/command-central` @ branch `main`
- **Version observed:** `0.6.0-rc.66` (unchanged — **no cut**, see §6)
- **Scope:** local only. **No publish / push / tag / GitHub release / version bump.**
- **Outcome:** ✅ One focused hot-path performance fix landed with tests. The
  per-running-task classification path no longer reads an entire (unbounded,
  growing) agent stream file just to inspect its last line. Full suite green
  (**2193 pass / 0 fail / 1 skip**), `just check` clean. RC readiness preserved;
  the cut remains deferred per the rc.66 prep judgment (no version churn here).

---

## 1. What was slow (the evidence)

The Agent Status tree's core per-task classifier is `toDisplayTask()`
(`src/providers/agent-status-tree-provider.ts`). For every **running** task it
calls `getStreamTerminalState()` (Tier 2b) to detect a terminal `turn.completed`
/ `turn.failed` / `result` event in the agent's JSONL stream. That delegates to
`_computeStreamTerminalState()`, which resolved the stream file and then did:

```ts
const lastEventLine = fs
    .readFileSync(streamFile, "utf-8")   // ← reads the ENTIRE file
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);                              // ← only the last line is used
```

i.e. it **slurped the whole stream file into memory, allocated an array of every
line, trimmed and filtered all of them — to keep exactly one line: the last**.

Why this matters (impact):

- Agent stream JSONL files **grow without bound** for the lifetime of a running
  task — every event the agent emits is appended. A long Claude/Codex session is
  routinely multiple MB.
- This read sits on the **hottest** render path: it runs once per *running* task
  per render cycle. The 5 s TTL cache (`_streamTerminalStateCache`) absorbs
  repeats inside a single synchronous burst, but it **expires between reload
  cycles** — and reloads are frequent: the file watcher fires a debounced
  `reload()` on every `tasks.json` write by the launcher, and the auto-refresh
  timer fires every 30 s while any task is running (30 s > the 5 s TTL, so every
  auto-refresh re-reads).
- Net: with N active agents and a busy launcher, the extension host repeatedly
  did `O(total stream bytes)` synchronous reads on its main thread purely to look
  at each file's tail. That is main-thread blocking proportional to how long
  agents have been running — exactly the wrong scaling.

This was chosen over other candidates because it is the clearest evidence-backed
hot-path waste that is safe to fix in isolation. Candidates considered and
**rejected** for this slice:

- **`getCompactChildren()` discards a `git log -1` spawn** (`getGitInfo()`
  computes `lastCommit` but compact mode only uses `branch`). Real waste, but
  compact mode is **off by default** (`agentStatus.compactMode: false`), so it is
  low-impact; left for a follow-up.
- **`readDiscoveredPrompt()` JSONL fallback** scans every transcript in every
  `~/.claude/projects` dir on a cache miss. Expensive, but already memoizes both
  hits *and* misses (`_discoveredPromptCache`), only fires for discovered
  (non-launcher) agents lacking a `prompt_file`, and is off the launcher-task hot
  path. Lower priority.
- **Proof false-positive (R1)** was already resolved upstream in `d742777a`
  (boundary-safe forbidden task-id matcher); nothing to do.

---

## 2. What changed

`_computeStreamTerminalState()` now calls a new bounded-tail reader instead of a
full-file read. Two small, single-responsibility private helpers were added:

| Symbol | Role |
| --- | --- |
| `STREAM_TAIL_BYTES = 64 * 1024` (static) | Tail window size. |
| `readLastNonEmptyStreamLine(streamFile)` | Returns the last non-empty line. Small files (≤ 64 KiB) are read in full (unchanged behavior); larger files read only the final 64 KiB. |
| `readFileTailUtf8(path, size, tailBytes)` | `openSync` → positioned `readSync` of the last `tailBytes` → `closeSync`. |

**Behavior preservation is exact**, by construction:

- A single stream event line is far smaller than 64 KiB, and the last non-empty
  line always sits at EOF, so it is always fully contained in the tail window →
  identical result to the full read.
- The tail window may begin mid-line; that leading partial fragment (and any
  UTF-8 split at the window's start) is discarded because we take the **last**
  non-empty line, never the first.
- Two tail-miss shapes fall back to a full read so the result is *never* worse
  than the original:
  - **No line break in the window** → a single final line longer than 64 KiB
    (an outsized event); full read so it still parses exactly as before.
  - **All-blank window** → the last non-empty line sits further back than 64 KiB;
    full read recovers it.
  Neither shape occurs for real agent streams (which end with the latest event
  line), so the fast path is the norm; the fallbacks exist purely to guarantee
  output-equivalence for pathological inputs.

The only added syscall on the fast path is one `statSync` (O(1) metadata) to get
the file size; the eliminated cost is the `O(file size)` content read + array
allocation. The public surface and all callers are unchanged.

Files changed:

- `src/providers/agent-status-tree-provider.ts` — the fix (+1 constant, swap the
  read, +2 helpers).
- `test/tree-view/agent-status-perf-caches.test.ts` — 5 new tests (below).

---

## 3. Tests

New `describe("readLastNonEmptyStreamLine — bounded tail read")` in the existing
perf-caches suite (real `node:fs` + real tmp files, matching the file's other
cache tests):

1. **small file** → returns the last non-empty line.
2. **large file (> 64 KiB)** → finds the final event line from the tail window
   (proves the tail read reaches EOF correctly for big files; filler is
   `turn.failed`, final line is `turn.completed`, so a head-only read would fail).
3. **large file with a blank tail window** → falls back and finds the earlier
   real line (a naive tail-only read would return `null` here — this pins the
   all-blank fallback and proves the window is bounded).
4. **oversized final line (no newline, > window)** → falls back to a full read
   and returns it intact.
5. **`getStreamTerminalState` on a large stream file** ending in `turn.completed`
   → resolves to `completed` (end-to-end behavior preserved through the public
   path).

> Note on what is *not* asserted: a behavior-preserving change is, by
> construction, output-identical to the original, so "bounded I/O" cannot be
> proven through return values alone. An earlier draft spied on `fs.readFileSync`
> /`fs.openSync`, but the harness's `node:fs` namespace mock copies the module
> object, so the provider's bound `fs.*` references are not the object a test can
> spy on (the spy assertions came back false while the functional ones passed).
> Rather than ship a brittle/false-confidence assertion, the bounded read is
> guaranteed structurally (code review of the `readSync(64 KiB)` vs full read)
> and the tests pin **correctness across every file shape**, including the two
> fallback paths a naive implementation would break.

Commands run (node, `ostehost@MacBookPro`):

| Command | Result |
| --- | --- |
| `bun test test/tree-view/agent-status-perf-caches.test.ts` | ✅ 22 pass / 0 fail (5 new) |
| `bun test test/tree-view/` (full tree-view suite) | ✅ 540 pass / 0 fail |
| `just check` (Biome ci + tsc + knip) | ✅ 0 errors, 8 pre-existing informational warnings |
| `just fix` | reformatted one long test line (no logic change) |
| `just test` (full suite + quality gate) | ✅ **2193 pass / 1 skip / 0 fail**; quality gate ✅ (0 `as any`, 0 reflection, 0 skips) |

(Baseline before the change: 2188 pass — the delta is the 5 new tests.)

---

## 4. Why this is safe to ship now

- No public API, signature, or caller changed; the classifier returns the same
  terminal state for all real inputs and all tested edge inputs.
- No model/agent hard-coding introduced — the stream read is backend-neutral
  (the existing `STREAM_BACKEND_PREFIXES` covers claude/codex/gemini and is
  untouched).
- The change is read-only with respect to the filesystem, git, and the live
  launcher registry. No external mutation.
- The fast path strictly reduces work; the fallbacks make the change a true
  no-op on output for every input.

---

## 5. Is the next RC closer? Remaining blockers

**Closer:** yes — this is a genuine product (extension `src/`) improvement to the
Agent Status hot path, so it is the kind of *shippable delta* the rc.66 prep doc
(`research/CC-NEXT-RC-PREP-2026-06-16.md`) said was missing. When the operator
next runs `just cut-preview`, rc.67 will now carry a real behavior-relevant
change (a faster classifier), not just a version-string bump.

**Blockers to the next RC:** none introduced. Standing, non-gating notes carried
forward from the rc.66 prep:

- **Local-only / unpushed.** `main` remains ahead of `origin/main`; push / tag /
  publish stay operator-driven (Tier 2). Not done here.
- **Reload to activate.** An installed RC needs **Developer: Reload Window** in
  already-open windows (standard).
- This task **did not** cut an RC — per the completion contract it implements the
  fix + tests + this note and stops. Cutting rc.67 is the operator's call via
  `just cut-preview` (readiness already proven in the rc.66 prep).

---

## 6. Constraint compliance

| Constraint | Status |
| --- | --- |
| No marketplace publish | ✅ none |
| No push / tag / GitHub release | ✅ none |
| No version bump / no cut | ✅ `package.json` untouched at `0.6.0-rc.66` |
| No destructive reset / history rewrite | ✅ none |
| No `--no-verify` | ✅ Biome pre-commit hook runs and passes |
| No external / live-registry mutation | ✅ change is read-only I/O on stream files |
| Agent/model neutrality preserved | ✅ no new Claude/agent hard-coding |
| Path-scoped staging (sibling-lane safety) | ✅ only the two changed files staged |
| Did not touch unrelated projects | ✅ Command Central only |

---

## 7. Suggested next steps for the operator

1. (Optional) Cut rc.67 via `just cut-preview` now that a shippable delta exists;
   then **Developer: Reload Window** + `just preview-status`.
2. Follow-up perf slice (separate task): stop `getCompactChildren()` from
   spawning the discarded `git log -1` (split a branch-only path out of
   `getGitInfo()`), and consider a bounded/streamed read for the
   `readDiscoveredPrompt()` JSONL fallback.
3. Push / tag / publish remain operator-driven (Tier 2) — not performed here.
