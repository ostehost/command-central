# Handoff — rc47 async preview hardening

- **Task id:** `cc-rc47-async-preview-hardening-20260528-0020`
- **Date:** 2026-05-28
- **Author:** post-preview hardening agent (Claude Opus 4.7)
- **Verdict:** **HARDENED** — Command Central now writes a durable preview-cut lifecycle bookmark and refuses duplicate runs. No push, no tag, no Marketplace publish performed.

## 1. Starting state (proof of host/path/git)

| Probe | Value |
| --- | --- |
| `hostname` | `MacBookPro.lan` |
| `whoami` | `ostehost` |
| `pwd` | `/Users/ostehost/projects/command-central` |
| `git status --short --branch` | `## main...origin/main [ahead 45]` (clean working tree) |
| `git rev-parse --short HEAD` | `82f13196` |
| `git rev-parse HEAD^{tree}` | `c95977b8efb29d45ec46bfd2570ba959e0509aa7` |
| `package.json` version | `0.6.0-rc.47` |
| rc47 VSIX | `releases/command-central-0.6.0-rc.47.vsix` |
| rc47 VSIX SHA256 | `65528c94de27c3d3e89bacbe2a142e7f2c1d955a7e59453c8ee26d096ef34f7e` |
| Latest preview gate (cached) | `research/prerelease-gate/latest.json` — CC `ccf470db…`, launcher `6a6effe1…`, all checks `passed` |

## 2. Final state

| Probe | Value |
| --- | --- |
| `git status --porcelain` | *(empty — clean)* |
| `git rev-parse --short HEAD` | `5bf0ba3e` |
| `git rev-parse HEAD^{tree}` | `b57c56205110f6cf22e90db25d4df44406af53de` |
| Commit message | `feat(release): durable preview-status tracker for cut-preview` |
| rc47 VSIX (unchanged) | still `0.6.0-rc.47`, SHA `65528c94…`. **No rc48 produced.** |
| Push / tag / publish | **None performed.** |

## 3. Root cause of the timeout ambiguity (Command Central side)

`just cut-preview` is a multi-stage synchronous recipe — preflight, `sync-launcher`, `ci` rehearsal, cross-repo `prerelease-gate`, `dist`, and VS Code install — that typically runs for several minutes. Before this change, it produced **no durable, repo-local lifecycle signal**. Its only side effects were:

- Live stdout/stderr to whatever TTY (or invoke pipe) it was attached to.
- Git churn (bumped `package.json`, new `releases/*.vsix`, new `research/prerelease-gate/*.json`) once the recipe finished a stage.

When OpenClaw / node-invoke wraps the recipe and that wrapper hits a per-call timeout, the underlying bash pipeline keeps running but its stdout pipe is now dead. From the invoker's seat there are four indistinguishable outcomes:

1. Still running normally.
2. Hung partway through.
3. Finished successfully — but invoker missed the closing lines.
4. Finished with failure — but invoker missed the error.

That's the ambiguity that caused earlier duplicate/ambiguous preview attempts: a second `just cut-preview` invoked while the first is still alive will stomp the version bump and the release archive cleanup, producing an inconsistent state.

The smallest correct fix on the Command Central side is a *bookmark*: a file that records the lifecycle independently of stdout, plus a startup guard that refuses to re-enter the recipe while another invocation is still alive.

## 4. Files changed (and why)

All in commit `5bf0ba3e`:

- **`scripts-v2/preview-status.ts`** *(new)* — pure module + CLI for the lifecycle bookmark.
  - Exposes `PreviewStatusStore` with `start`/`finish`/`read`/`classify`/`clear`, plus pure helpers `parseRecord`, `classifyState`, `defaultIsAlive`, `formatRecord`.
  - State file: `.preview-status/state.json` (atomic write via `*.tmp` + `rename`).
  - Schema v1 records: `state` (`running` / `succeeded` / `failed` / `unknown`), `pid`, `command`, `cwd`, `host`, `user`, `startedAt`, `finishedAt`, `durationMs`, `logPath`, `packageVersion`, `artifactPath`, `artifactSha256`, `exitCode`.
  - Liveness probe is `process.kill(pid, 0)`: `ESRCH` → dead, `EPERM` → alive (don't stomp another user's job).
  - `start` refuses (exit code `2`, `ALREADY_RUNNING`) when an existing record's stored state is `running` and its pid is still alive. `--force` overrides.
  - `classify` reclassifies a stale `running` record (dead pid) to `unknown`. `succeeded` / `failed` records pass through.
  - CLI subcommands: `start`, `finish`, `show [--json]`, `clear`, plus a `--state-dir` override used by tests.

- **`test/scripts-v2/preview-status.test.ts`** *(new)* — 21 focused tests covering:
  - schema parse round-trip, invalid JSON, schema version mismatch, unknown state values, optional-field coercion;
  - `classifyState`: succeeded passthrough, live pid stays running, dead pid → unknown, null pid → unknown;
  - `start`: writes a record, refuses on live-running, replaces on stale, `--force` overwrites live;
  - `finish`: success/failure flip, duration computation, refusal when no record;
  - `classify`/`clear`: `none` on empty, `unknown` on stale, idempotent clear;
  - `formatRecord` rendering of stored-vs-live mismatch.

- **`justfile`** — `cut-preview` rewritten as a bash shebang recipe that:
  1. Calls `preview-status start` (fails fast with rc=2 if another cut is alive).
  2. Registers an `EXIT` trap calling `preview-status finish --exit-code=$rc`.
  3. `exec > >(tee "$LOG_FILE") 2>&1` to mirror all subsequent output into `.preview-status/cut-preview-<utc-timestamp>.log`.
  4. Runs the exact same body as before (`_preview-preflight` → `sync-launcher` → `_preview-rehearsal` → `prerelease`). No behavioral change to the cut itself.
  5. Updated "Next steps" panel adds step 6: `just preview-status — confirm SUCCEEDED`.
  - New recipe: `preview-status *args=""` → `bun run scripts-v2/preview-status.ts show {{args}}`.
  - Default help now lists `preview-status`.

- **`.gitignore`** — adds `.preview-status/` so logs and the state file never enter git.

Nothing in `releases/`, `research/prerelease-gate/`, `package.json`, or any cross-repo file was touched. The cut output for rc47 is preserved verbatim.

## 5. Tests / checks run (all pass)

| Check | Command | Result |
| --- | --- | --- |
| New unit tests only | `bun test test/scripts-v2/preview-status.test.ts` | **21 pass / 0 fail** (112 ms) |
| All scripts-v2 tests | `bun test test/scripts-v2/` | **50 pass / 0 fail** (3.4 s) |
| Read-only gate | `just check` (biome ci + tsc + knip) | **pass** |
| Strict gate | `just ci` (biome ci + tsc + knip strict + full suite + coverage) | **pass — 1677 pass / 1 skip / 0 fail** |
| Pre-commit hook | biome on staged files | **pass** (no `--no-verify`) |
| End-to-end CLI smoke | manual: `start` → duplicate-start refusal with live pid → `finish` → `show` → `clear` | **pass** — duplicate `start` against a live sleep pid exited with rc=2 and printed the recovery instructions; the same flow against a dead pid replaced the stale record as expected |

No new preview cut was attempted; rc47 remains the latest. Per task scope, dry-run/fixture tests cover the new behavior in place of producing rc48.

## 6. How Oste should use this next time

### Cutting an rc

```bash
just cut-preview                # unchanged; now also writes .preview-status/state.json
```

If a previous cut is still running, the new invocation fails fast with exit 2 and a clear message naming the running command, pid, and log file.

### Observing a running or recent cut

```bash
just preview-status             # human-readable record + live state
just preview-status --json      # JSON for tooling / OpenClaw polling

# Show the full log tail of the latest cut
tail -F .preview-status/cut-preview-*.log
```

### Recovering from a stale `unknown`

If `just preview-status` reports `state: unknown` (meaning the recorded pid is gone), inspect the log to determine whether the cut actually finished, then either:

- Verify the rc artifact in `releases/`, finalize manually if appropriate, then:
  ```bash
  bun run scripts-v2/preview-status.ts clear
  ```
- Or start a fresh cut (the stale record will be auto-replaced, since its pid is dead):
  ```bash
  just cut-preview
  ```

### Forcing a fresh start over a live job (rare, dangerous)

```bash
kill -TERM <pid-from-just-preview-status>
bun run scripts-v2/preview-status.ts clear
just cut-preview
```

`bun run scripts-v2/preview-status.ts start --force` also works if you've manually verified the prior process is dead but the kernel happens to have recycled the pid to another live process (e.g., your `process.kill(pid, 0)` probe lies because something else is now using the pid).

### OpenClaw / node-invoke integration pattern

When invoking `just cut-preview` over node-invoke, you no longer need to keep the invoke pipe open for the entire cut. After firing the command, the caller can poll independently:

```bash
bun run /Users/ostehost/projects/command-central/scripts-v2/preview-status.ts \
    --state-dir /Users/ostehost/projects/command-central/.preview-status \
    show --json
```

`state` will progress `running → succeeded | failed`; `unknown` means the pid died without a normal `finish` — investigate the log.

## 7. Remaining risks and what's out of scope

1. **Tee-on-exec timing.** `exec > >(tee "$LOG_FILE") 2>&1` causes the bash trap-on-EXIT to run while the `tee` subprocess is still draining its pipe. Bash handles this correctly in practice (the `finish` CLI is short and prints to a closed stdout), but if Oste ever sees a missing `finish` record on a clean exit, the workaround is to redirect `preview-status finish`'s output to `/dev/null` (already done in the trap).
2. **Cross-repo half-baked state.** The bookmark is Command Central-local. If `prerelease-gate` aborts mid-launcher-validation it will produce a `failed` CC record, but launcher-side work is still recoverable via `~/projects/ghostty-launcher` `git status`. The CC bookmark is *not* a cross-repo lock; it does not replace the existing preflight clean-tree guard.
3. **No async/background variant yet.** This change keeps `cut-preview` synchronous from the user's perspective. If a future need arises to *launch* the cut detached (so the calling terminal can close), the cleanest follow-up is a new `cut-preview-async` recipe that `nohup`s the existing recipe and exits immediately — all the lifecycle plumbing it would need is already in `preview-status.ts`. Not done because the user explicitly requested the smallest useful change.
4. **OpenClaw / node-invoke side.** OpenClaw could still benefit from a routing rule that, when `just cut-preview` is the target, switches to a "fire-and-poll" pattern reading `.preview-status/state.json` instead of holding the invoke pipe open. That belongs in OpenClaw or the launcher invoke layer, not in Command Central. Concrete next step there would be a new dispatch verb that pairs `just cut-preview` invocation with periodic `preview-status show --json` polling. **No code changes proposed in those repos in this handoff.**

## 8. Explicit safety statement

- ❌ No `git push` performed.
- ❌ No git tag created.
- ❌ No `gh release create` / Marketplace publish performed.
- ❌ No `--no-verify` used on commit (pre-commit biome hook ran and passed).
- ❌ No additional preview cut produced; rc47 remains the latest and is byte-identical to the dispatch-time hash.
- ✅ One commit on `main` (local only): `5bf0ba3e`.
- ✅ Working tree is clean post-commit (verified `git status --porcelain` empty).
