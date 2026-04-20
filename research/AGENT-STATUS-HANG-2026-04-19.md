# Agent Status hang — root cause and fix (2026-04-19)

Task: `command-central-agent-status-hang-20260419-2028`
Node: MacBook (dogfood)

## Symptom

- Agent Status view stuck in "loading…" state.
- VS Code renderer logs repeatedly fired
  `extension host (oste.command-central) is unresponsive` warnings.
- CPU profiles attributed essentially all time to `parsePsOutput` in
  `src/discovery/process-scanner.ts`.
- Agent Status output channel produced no useful signal because the extension
  host was pegged before the diagnostics path could run.

## Root cause

`parsePsOutput` runs three regexes against every `ps` row:

- `AGENT_CLI_RE` (composite of `CLAUDE_CLI_HINT_RE`, `CODEX_CLI_HINT_RE`,
  `GEMINI_CLI_HINT_RE`)
- `EXCLUDED_BINARY_RE`

Both `CODEX_CLI_HINT_RE`, `GEMINI_CLI_HINT_RE`, and `EXCLUDED_BINARY_RE`
contained the path-prefix sub-pattern:

```regex
(?:[^\s"']*/)*
```

`[^\s"']*` is greedy and unbounded — but it can also match `/`. That makes
the outer `(?:X/)*` ambiguous: a path like `/a/b/c/d` can be consumed in many
different (group-iteration-count, segment-length) combinations. When the
trailing literal (`codex`, `gemini`, `terminal-notifier`) is **not** present,
the engine has to enumerate every possible split before declaring no match.
This is textbook ReDoS / catastrophic backtracking.

On the MacBook node there are typically several `claude` orchestrator
children whose **entire prompt is baked into argv**, producing 3–7 KB `ps`
rows that contain many embedded `/` characters (paths in the prompt). For
each such row, the codex/gemini hint regexes plus the excluded-binary check
each spent **~2 seconds** inside the regex engine. Five or six such rows per
scan = enough sustained CPU to trip the VS Code unresponsive-extension-host
heuristic and leave the tree provider in its loading state forever.

### Reproduction

```ts
const long = "claude " + "/Users/me/projects/foo/bar/baz/qux/quux/corge/grault/garply/aaa".repeat(60) + " end";
CODEX_CLI_HINT_RE.test(long);     // ~1900 ms
GEMINI_CLI_HINT_RE.test(long);    // ~1750 ms
EXCLUDED_BINARY_RE.test(long);    // ~2400 ms
```

A live `ps -eo pid,ppid,lstart,command` snapshot from the affected machine
(667 rows / 156 KB) was running multiple such `claude` children
simultaneously, so each scan iteration burned tens of seconds.

## Fix

`src/discovery/process-scanner.ts` — replace `[^\s"']*` (and the matching
`[^\s"']+` tail class) with `[^\s"'/]*` / `[^\s"'/]+` inside the path-segment
quantifiers, so each iteration of `(?:SEG/)*` consumes exactly one segment +
its trailing slash. The match is now deterministic and linear in path length.

Patched regexes:

- `CODEX_CLI_HINT_RE` (direct-binary alt and `node_modules/@openai/codex` alt)
- `GEMINI_CLI_HINT_RE` (direct-binary alt and `node_modules/@google/gemini-cli` alt)
- `EXCLUDED_BINARY_RE` (helper-binary path prefix)

Two named constants were introduced (`PATH_SEGMENT_CLASS`, `PATH_TAIL_CLASS`)
and a comment explains the constraint so future edits don't reintroduce the
bug.

`CLAUDE_CLI_HINT_RE` was untouched — it had no nested-quantifier path
pattern.

## Validation

- New regression test
  `parsePsOutput stays linear on long ps rows with many slashes` constructs
  51 multi-KB `claude` rows with embedded paths and asserts
  `parsePsOutput` completes in < 500ms. Pre-fix this took >30s for a single
  row. Post-fix the whole batch runs in < 5ms.
- All 45 existing `process-scanner.test.ts` tests pass unchanged — including
  the "ignores near-miss codex/gemini path segments" and
  "filters terminal notification helpers" tests, which is the load-bearing
  evidence that the fix preserves the same matching semantics.
- Full repo `bun test` run: **1356 pass / 1 fail / 1357 total**. The single
  failure is `discovery diagnostics report shows retained vs filtered scanner
  matches` in `agent-status-tree-provider-discovery.test.ts` — confirmed
  pre-existing on `main` (re-ran with the patch stashed and it still failed
  identically). It is a Registry-counting assertion mismatch, unrelated to
  process-scanner regex behavior.
- Live validation: ran `parsePsOutput` against the actual `ps` output on the
  affected MacBook (667 rows / 156 KB, including the running long-prompt
  `claude` children). Pre-fix this would have hung for >30 s; post-fix the
  scan completes in **6 ms**.
- I did **not** load the patched extension into a live VS Code session and
  observe Agent Status responsiveness from the renderer side — `code` was
  not started under `--extensionDevelopmentPath` here. The fix is validated
  at the `parsePsOutput` boundary (which is where 100% of the CPU profile
  pointed), and both the unit-test regression and the live-`ps` smoke test
  pass with margin to spare. End-to-end UI verification on the dogfood
  machine is the recommended next step.

## Caveats / follow-ups

- The wall-clock CPU savings only apply when there are long `ps` rows. On a
  quiet machine the scan was already fast, so this fix won't change anything
  visible there.
- `dedupedResults` in `parsePsOutput` does an O(n²)-ish parent-pid walk but
  `n` is the candidate-after-filter count (typically <10) so this is not a
  scaling concern; left untouched.
- Consider adding a simple wall-clock guard around `getPsOutput` →
  `parsePsOutput` → `getProcessCwd` and surfacing it in the Agent Status
  diagnostics report. That would have made this hang trivially diagnosable
  from the output channel instead of needing a CPU profile. Out of scope
  for this fix.
- The pre-existing
  `discovery diagnostics report shows retained vs filtered scanner matches`
  test failure looks like Registry running/completed-counting drift; worth
  triaging separately.
