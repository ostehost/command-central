# HANDOFF — preview-status CLI/recipe usability fixup

- Task id: `cc-preview-status-cli-fixup-20260528-0029`
- Date: 2026-05-28
- Host: `Mike MacBook Pro` (node)
- Repo: `/Users/ostehost/projects/command-central`
- Branch: `main` (canonical checkout, no worktree)

## Verdict

**FIXED.** Both CLI/recipe defects reported in the rc47 hardening review are corrected, with focused unit + subprocess test coverage, no preview cut, push, tag, or publish performed.

## Starting state

- Starting HEAD: `f0187345 docs(research): record preview-status hardening handoff`
- Starting `git status`: clean
- Starting tree: clean

## Final state

- Final HEAD: `<new commit>` (this fixup, see commit summary below)
- Final `git status --porcelain`: clean
- Final tree: clean

## Defects addressed

1. **Justfile `clear` was dead.** `preview-status *args=""` hardcoded `show {{args}}`, so `just preview-status clear` re-entered `show` with `clear` as a stray positional and printed `preview-status: no record (state: none)`. The recipe now forwards `{{args}}` verbatim; the CLI itself decides the default subcommand.
2. **Global `--state-dir` before subcommand exited rc=64.** `runCli()` destructured `[sub, ...rest] = argv`, so `bun run scripts-v2/preview-status.ts --state-dir <dir> show --json` treated `--state-dir` as the subcommand and errored with `unknown subcommand "--state-dir"`. The CLI now hoists global flags (`--state-dir <dir>`, `--state-dir=<dir>`, `--help`, `-h`) out of any position before resolving the subcommand.

## Implementation summary

- New exported helper `parseCli(argv: string[]): ParsedCli` in `scripts-v2/preview-status.ts` separates global flags from the subcommand and its args.
  - `--state-dir <dir>` and `--state-dir=<dir>` accepted before or after the subcommand.
  - `--help` / `-h` accepted anywhere.
  - When the first non-global positional is missing or starts with `--`, subcommand defaults to `show`. That lets `just preview-status` and `just preview-status --json` work as shorthand without making typos silently degrade.
  - An unrecognised positional (e.g. `clearr`) still returns rc=64 with `unknown subcommand "clearr"`.
- `runCli()` now consumes `parseCli`'s output; subcommand dispatch is exhaustively typed.
- Justfile recipe:
  ```just
  preview-status *args="":
      @bun run scripts-v2/preview-status.ts {{args}}
  ```
  No more hardcoded `show`.

## Files changed

- `justfile` — recipe forwards `{{args}}` verbatim instead of injecting `show`.
- `scripts-v2/preview-status.ts` — new `parseCli` helper and exports (`parseCli`, `PREVIEW_STATUS_SUBCOMMANDS`, `PreviewStatusSubcommand`, `ParsedCli`); `runCli` rewritten on top of it; help text expanded to mention global flags.
- `test/scripts-v2/preview-status.test.ts` — 11 new `parseCli` unit tests + 6 CLI subprocess smoke tests covering the four required shapes plus regression coverage for `--state-dir` placement and unknown subcommand errors.

## Tests run

### `bun test test/scripts-v2/preview-status.test.ts`

```
 39 pass
 0 fail
 68 expect() calls
Ran 39 tests across 1 file.
```

### `bun test test/scripts-v2/` (broader suite)

```
 68 pass
 0 fail
 119 expect() calls
Ran 68 tests across 4 files.
```

### `just check`

```
Checked 245 files in 193ms. No fixes applied.
✅ Checks complete!
```

(Required `just fix` first to apply Biome's organize-imports + format auto-fixes
on the new test imports — pre-commit gate uses the same Biome ruleset, so this
is the canonical workflow.)

### `just test` (full suite)

- 1696 tests across 121 files
- 1 fail: `AgentStatusTreeProvider — discovery > dogfood discovery integration > discovery diagnostics report shows retained vs filtered scanner matches`
- Verified preexisting: same failure occurs at starting HEAD `f0187345` after stashing this fixup's diffs. The dogfood test reads `~/.config/ghostty-launcher/tasks.json` and depends on a running Ghostty window (`can't find window: agent-my-app`), so it is unrelated to preview-status changes and outside the scope of this fixup.

### Recipe + CLI smoke (all four required shapes)

Run with a fresh tmpdir state-dir:

```fish
set d (mktemp -d)

# Shape 1: just preview-status defaults to show
just preview-status --state-dir $d
# → preview-status: no record (state: none)

# Shape 2: just preview-status --json runs show --json
just preview-status --state-dir $d --json
# → {"state":"none"}

# Shape 3: just preview-status clear dispatches the real clear subcommand
echo '{"version":1,"state":"succeeded","exitCode":0}' > $d/state.json
just preview-status --state-dir $d --json
# → {…"state":"succeeded"…} (proves show reads the seeded file)
just preview-status --state-dir $d clear
# → preview-status: cleared
just preview-status --state-dir $d --json
# → {"state":"none"}                 (proves clear actually deleted state.json)

# Shape 4: just preview-status show --json continues to work
echo '{"version":1,"state":"failed","exitCode":7}' > $d/state.json
just preview-status --state-dir $d show --json
# → {…"state":"failed"…,"exitCode":7,…}

# Handoff/OpenClaw shape: --state-dir BEFORE subcommand (this is the rc=64 case before the fix)
bun run scripts-v2/preview-status.ts --state-dir $d show --json
# → {…"state":"failed"…} (rc=0)

rm -rf $d
```

All four shapes verified locally; subprocess equivalents are encoded in
`describe("preview-status CLI (subprocess smoke)", …)` and run on every
`bun test` invocation.

## Remaining risks / known limitations

- **Pre-existing dogfood integration failure** in `test/tree-view/agent-status-tree-provider-discovery.test.ts`. Out of scope; documented above. Worth a separate task to either gate it behind a `RUN_DOGFOOD_INTEGRATION=1` env var or fix the window-discovery flake.
- **`--help` placement change.** Help is now a global flag; previously only `--help`/`-h` *as the subcommand* triggered help. Behavioural impact is strictly additive (more positions accepted), and no caller depended on, e.g., `preview-status show --help` doing something subcommand-specific.
- **`PREVIEW_STATUS_SUBCOMMANDS` is exported.** Now part of the module's public surface for `parseCli`'s exhaustiveness check. If a future subcommand is added, both the tuple and the dispatch branches must be updated — TypeScript's `never`-typed `_exhaustive` check will fail loudly if they drift.

## Cross-repo & release-path activity

- **No preview cut performed.** `just cut-preview`, `just prerelease`, `just dist`, `just sync-launcher`, `just sync-all` were not invoked.
- **No push, tag, or Marketplace publish.** No remote-mutating git operations were run. Branch is unchanged from `origin/main` aside from the new fixup commit on top of the existing 47-commit local lead.
- **No `--no-verify`, `--force`, reset, clean, or stash-drop.** The temporary `git stash` used to confirm the dogfood failure is preexisting was popped immediately; tree is clean.
- **Ghostty Launcher repo untouched.** No work in `~/projects/ghostty-launcher`.

## Commit

Single conventional commit with full hook gate (Biome + tsc + tests):

```
fix(preview-status): default to show and hoist global --state-dir
```

(See `git log -1` for the final hash.)
