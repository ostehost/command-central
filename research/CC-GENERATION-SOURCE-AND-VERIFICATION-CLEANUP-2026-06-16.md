# CC — Release-Generation Source Wiring + Verification/Provenance Cleanup

- **Task id:** `cc-generation-source-and-verification-cleanup-20260616`
- **Date:** 2026-06-16
- **Repo:** `/Users/ostehost/projects/command-central`
- **Role:** developer (implementation)
- **Follows up:** review of `cc-agent-status-live-terminal-state-20260615`
  (handoff `research/AGENT-STATUS-LIVE-TERMINAL-STATE-FIX-2026-06-15.md`, now
  carrying a §8 correction addendum).
- **Coordinates with (read-only, NOT edited):** launcher commit `ee07e295`
  (`scripts/oste-terminal-generation.sh`) and the in-flight launcher follow-up
  `ghostty-launcher-app-generation-stamping-20260616` (stamps per-lane/receipt
  `app_stamp`).
- **Constraints honored:** CC repo only. No launcher / OpenClaw / Symphony edits.
  No VS Code settings mutation, no extension install, no publish/release/push.
  Truthful status over pretty status.

---

## 1. Mission recap

The predecessor shipped a **dormant** release-hygiene guard: a terminal-status
lane whose Ghostty app/window belongs to a *prior* release generation must not be
badged "live · lifecycle conflict" just because its orphan tmux pane is still
alive. The guard was inert because `getCurrentReleaseGeneration()` returned
`null` (no source) — and it modeled the per-lane marker as a single string
`release_generation` that **does not match** what the launcher actually stamps.

This task: (1) correct the verification/provenance record, (2) wire the
current-generation source against the **real** launcher schema, test-first, and
(3) keep it a safe no-op when the source is absent.

---

## 2. The launcher schema (read from `scripts/oste-terminal-generation.sh`)

The prior CC code assumed `release_generation` (string) / `source_version`
(alias). The launcher's actual contract is an **`app_stamp` object**, not a
string:

### 2a. Per-lane / per-receipt `app_stamp` (object)
Stamped on each terminal lane by the launcher follow-up
(`ghostty-launcher-app-generation-stamping-20260616`). Four **identity fields**:

```jsonc
"app_stamp": {
  "launcher_version":    "v0.6.0-rc.65-3-gabc1234", // git describe --tags --always --dirty
  "git_sha":             "abc1234",                  // short HEAD of the launcher repo
  "rc_version":          "0.6.0",                    // installed Ghostty.app CFBundleShortVersionString
  "template_generation": "deadbeef0000"              // hash-object of the bundle template (`launcher`)
}
```

### 2b. Current-generation **baseline** file (object)
Written by `oste-terminal-generation.sh stamp` to
`OSTE_RELEASE_GENERATION_FILE` (default
`~/.config/ghostty-launcher/release-generation.json`). Same four fields **plus**
`stamped_at`:

```jsonc
{ "launcher_version": "...", "git_sha": "...", "rc_version": "...",
  "template_generation": "...", "stamped_at": "2026-06-16T00:00:00Z" }
```

### 2c. The launcher's own verdict logic (which CC mirrors)
`cmd_check` compares each running lane's `app_stamp` to the current stamp:
- **all four fields equal** → `reuse` (the .app is current);
- **any field drifted** → `rebuild` (superseded — recreate the .app);
- **`app_stamp` absent or any field missing** → `unknown` (do **not** silently
  trust as current).

CC's representation maps onto this exactly: equal ⇒ keep live badge,
drift ⇒ `stale (pre-release)`, unknown ⇒ not judged (current behavior).

> The launcher tool is strictly read-only/non-destructive; `current` and `check`
> never touch terminals and `stamp` only writes the baseline file. CC likewise
> only *represents* — it never kills an app or pane.

---

## 3. Changes (this repo)

All in `src/providers/agent-status-tree-provider.ts`, `package.json`, and the
test file. No launcher edits.

### 3a. `canonicalGenerationToken(value): string | null` (new, exported, pure)
Reduces **either** input shape to one comparable token:
- a **string** (`release_generation` / `source_version`) → trimmed; blank → null;
- an **`app_stamp` object** (or the baseline object) → requires **all four**
  identity fields non-blank (exactly the launcher's `unknown` gate) and collapses
  them to a canonical `launcher_version|git_sha|rc_version|template_generation`
  join; any missing field → `null` (unknown → not judged). Extra fields
  (`stamped_at`) are ignored. Arrays / non-objects → null.

This is the single point of **field compatibility** with the launcher: all-four-
equal ⇒ equal tokens ⇒ "reuse"/current; any drift ⇒ unequal ⇒ "rebuild"/
superseded; incomplete ⇒ null ⇒ "unknown".

### 3b. `normalizeTask` wires `app_stamp` → `release_generation`
```ts
release_generation:
  canonicalGenerationToken(raw["app_stamp"]) ??
  canonicalGenerationToken(raw["release_generation"] ?? raw["source_version"]),
```
Object form preferred (the launcher's real stamp); string forms kept as a simpler
fallback. The downstream pure predicate `isSupersededByReleaseReset(task,
current)` is unchanged — it still compares two opaque tokens for inequality, now
fed canonical tokens from both sides.

### 3c. `getCurrentReleaseGeneration()` now sourced from the launcher baseline
- Test seam first: `_currentReleaseGenerationOverride` (non-null) short-circuits.
- Otherwise `readCurrentReleaseGenerationFromState()`:
  - **Path resolution** (`getReleaseGenerationFilePath()`, env-first to match the
    launcher tool's own override):
    1. `OSTE_RELEASE_GENERATION_FILE` env var (the launcher tool's override);
    2. `commandCentral.releaseGeneration.file` setting (operator override).
    The well-known default lives **only in package.json**
    (`~/.config/ghostty-launcher/release-generation.json`), so **no
    user-specific absolute path is hardcoded in code**, and **config-less hosts
    (unit-test mocks) resolve `null`** — the operator's real `$HOME` baseline
    never leaks into hermetic tests (same discipline as `laneRegistry.files`).
  - Read + `JSON.parse` + `canonicalGenerationToken`, wrapped in try/catch:
    **missing file or malformed JSON → `null`, no throw**. Result memoized with a
    5 s TTL keyed by path so the per-render hot path does not re-stat the file.
- `~` / `~/` expansion via a small local `expandHomePath` helper (mirrors the
  resolver's private `expandHome`).

### 3d. `package.json`: new setting `commandCentral.releaseGeneration.file`
`scope: machine`, default `~/.config/ghostty-launcher/release-generation.json`,
documented as overridable by `OSTE_RELEASE_GENERATION_FILE`, inert when the file
is absent/malformed/incomplete.

### 3e. Doc/provenance corrections (Required outcome #1)
`research/AGENT-STATUS-LIVE-TERMINAL-STATE-FIX-2026-06-15.md`:
- §2 test count corrected (`19` → **27**) inline.
- §3 each broad-suite line now labeled with the **environment** it was run in
  (author's main checkout w/ deps); the focused-test line flagged as the
  portable, review-confirmed evidence.
- New **§8 addendum**: two-commit provenance (`eb28320d` carried the
  `agent-task-classification.ts` change, **not** `56709213`); test count;
  verification-claim scope; corrected release-hygiene one-liner (the guard was
  inert *only* for lack of a source and has *always* been scoped to the
  terminal-status conflict path); and the `app_stamp`-vs-string schema correction.

---

## 4. Tests (test-first) — `test/tree-view/agent-status-live-terminal-state.test.ts`

**39 pass** (was 27; +12). New coverage:

**`canonicalGenerationToken` (pure, 6 tests):**
- string token passthrough (trimmed); blank/`null`/`undefined`/number/array → null;
- complete `app_stamp` object → canonical `lv|gs|rc|tg`;
- baseline shape (`app_stamp` + `stamped_at`) → same token (extra field ignored);
- **incomplete stamp** (each of the four fields missing *or* blank) → null
  (mirrors the launcher's `unknown` gate);
- a complete stamp + a drifted baseline drive `isSupersededByReleaseReset` via the
  shared token (drift → true, match → false).

**`getCurrentReleaseGeneration` against a real state file (6 tests):**
Each writes a **temp** baseline (real fs) and points the provider at it via
`OSTE_RELEASE_GENERATION_FILE` (env snapshot/cleared in `beforeEach`, restored in
`afterEach`; temp dir removed). The in-memory override is left `null` on purpose
so the **production read path** is exercised:
- **reads current generation** from the env-pointed baseline → a lane whose
  token matches keeps `⚠ live · lifecycle conflict`;
- a lane from a **different** generation than the baseline → `stale (pre-release)`;
- **missing file** → null → guard inert (live badge preserved);
- **malformed JSON** → null with **no crash** (asserted via `not.toThrow`);
- **incomplete baseline** (missing identity fields) → unknown → inert;
- **config-less host** (no env, mock returns `""` for the setting) → operator's
  real `$HOME` baseline is **never read** → inert (hermeticity proof).

The existing generation-mismatch suppression tests (override seam) are unchanged
and still pass; the existing release-hygiene block additionally got defensive env
hygiene so an ambient `OSTE_RELEASE_GENERATION_FILE` can never leak into it.

### Verification run (this environment = main checkout, deps installed)
```
bun test test/tree-view/agent-status-live-terminal-state.test.ts   # 39 pass / 0 fail
bun test test/tree-view/                                            # 535 pass / 0 fail
just test                                                          # 2183 pass / 1 skip / 0 fail
just check                                                         # exit 0 (8 pre-existing knip warnings in agent-status-perf-caches.test.ts; none in touched files)
bunx tsc --noEmit                                                  # exit 0
bun run build                                                     # exit 0 (VSIX built; regenerated tracked digest reverted — see §6)
```
**Honesty note (Required outcome #5):** all of the above ran cleanly **here**
because this is the main working checkout with `bun install` already done. In a
fresh isolated worktree lacking deps / `@types/vscode`, only the **focused** test
is reliably runnable — that is the portable evidence and it passes. I did not
attempt to fabricate a green broad-suite from an environment that can't run it.

---

## 5. Exact schema expected from the launcher (the cross-repo contract)

For the guard to *activate correctly*, the launcher half
(`ghostty-launcher-app-generation-stamping-20260616`) must provide:

1. **Per-lane `app_stamp`** on each terminal lane in the registry CC reads
   (`tasks.json` / lanes projection), with **all four** identity fields
   populated: `launcher_version`, `git_sha`, `rc_version`, `template_generation`.
   - CC also accepts a single-string `release_generation`/`source_version` as a
     simpler fallback, but the object is the real contract and is preferred.
   - If any field is missing, CC treats the lane generation as **unknown** and
     does not judge it (no false staleness) — matching the launcher's own
     `unknown` verdict.
2. **Baseline file** at `OSTE_RELEASE_GENERATION_FILE` (default
   `~/.config/ghostty-launcher/release-generation.json`) written by
   `oste-terminal-generation.sh stamp`, with the same four fields (+`stamped_at`).
   CC reads this as the *current* generation.
3. **Re-stamp/retire on reset:** when the release/reset flow recreates the
   Ghostty `.app` windows, it must (a) re-`stamp` the baseline to the new
   generation and (b) leave superseded lanes carrying their **old** `app_stamp`
   (so CC can recognize them as pre-reset). CC never mutates either side.

Token equality semantics CC relies on: **all four fields equal ⇒ current**
(keep live), **any drift ⇒ superseded** (`stale (pre-release)`), **incomplete ⇒
unknown** (unchanged behavior). This is deliberately identical to the launcher's
`reuse` / `rebuild` / `unknown` so the two tools never disagree.

---

## 6. Remaining risks / scope qualifiers (truthful)

1. **Terminal-status path only (unchanged scope).** The guard governs the
   **terminal-status** lifecycle-conflict path. A **`running`-status** lane whose
   Ghostty app was superseded but whose pane is a live orphan is still unguarded
   (predecessor §6 follow-up #3). Same `isSupersededByReleaseReset` predicate
   applies; wiring it into the running-liveness path is deliberately out of scope
   here ("smallest safe wiring").
2. **Activation depends on the launcher half.** Until
   `ghostty-launcher-app-generation-stamping-20260616` stamps per-lane `app_stamp`
   **and** the baseline file exists, lanes carry no generation token →
   `isSupersededByReleaseReset` returns false → **no behavior change**. The guard
   is "armed but quiet": current source wired (this task), per-lane source pending
   (launcher).
3. **`stamped_at` is not used for ordering.** CC compares tokens for *inequality*
   only (versions/sha/hashes have no reliable order); `currentGeneration` (the
   baseline) is assumed authoritative/latest. This matches the launcher, which
   also does equality-not-ordering.
4. **Stale-detail verbosity.** The "Stale terminal app" detail interpolates the
   canonical token, which for an `app_stamp` is a `lv|gs|rc|tg` join (longer than
   a bare `rc.64`). It is informative and only shown on already-superseded lanes;
   left as-is to avoid churn. A future polish could show just `rc_version`.
5. **Build side-effect (handled).** `bun run build` packages a VSIX and
   regenerated the tracked `releases/digest-v0.6.0-rc.65.md`; that unrelated
   release-artifact change was **reverted** (`git checkout --`) so the commit
   carries only the intended source/test/doc/config changes. No release was cut,
   tagged, or pushed.
6. **Hot-path file read.** `getCurrentReleaseGeneration()` is consulted per lane
   at three render sites; the 5 s TTL memo means at most one `readFileSync` per
   5 s regardless of lane count (consistent with the existing tmux/persist health
   caches). Missing-file reads are caught and the `null` is cached too.

---

## 7. Files changed (committed)

- `src/providers/agent-status-tree-provider.ts` — `canonicalGenerationToken`
  (new export), `expandHomePath` helper, `app_stamp` normalization,
  `getCurrentReleaseGeneration` wired to the baseline file +
  `getReleaseGenerationFilePath` / `readCurrentReleaseGenerationFromState` +
  TTL cache field, doc updates.
- `package.json` — new `commandCentral.releaseGeneration.file` setting.
- `test/tree-view/agent-status-live-terminal-state.test.ts` — +12 tests
  (canonical token + real-state-file source), env hygiene.
- `research/AGENT-STATUS-LIVE-TERMINAL-STATE-FIX-2026-06-15.md` — §2/§3 inline
  corrections + §8 verification/provenance addendum.
- `research/CC-GENERATION-SOURCE-AND-VERIFICATION-CLEANUP-2026-06-16.md` — this
  handoff.

No `vscode` module bundling change; `external: ['vscode']` untouched; all imports
keep `.js` extensions.
