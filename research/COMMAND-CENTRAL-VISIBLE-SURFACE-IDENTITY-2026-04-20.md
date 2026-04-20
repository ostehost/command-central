# Command Central — Visible Surface Identity Investigation (2026-04-20)

task_id: `cc-visible-surface-identity-20260420-1852`
worktree branch: detached from `main` at `21dc295` (rc.5)
baseline: `21dc295 chore(release): cut v0.6.0-rc.5` — **still current**

## Summary

Investigated the observed "visible app-surface identity mixup" — Ghostty
Launcher shows the expected app/icon in one place, Cmd+Tab shows an older
or wrong persona, and terminal content appears to belong to a ghostty-
launcher tmux lane while the visible shell/menu-bar identity is something
else. The brief explicitly called out the case of `ghl-visible-permission-
prompt-hygiene-20260420-1822`: a tmux-headless launcher task (`bundle_path=
(tmux-mode)`, `ghostty_bundle_id=null`, `exec_visible=false`) for which any
visible surface appearing after a focus click is *not* an authoritative
visible task bundle for that lane.

The root-cause surface is a boundary issue, but inside that boundary there
is one concrete, narrow CC-side bug that was breaking the truth of our own
Strategy 3 narration. **That bug is fixed in this worktree.** The broader
stale-persona symptom (old 🎮 icon in Cmd+Tab) is **not** a CC bug — it is
ghostty-launcher / LaunchServices / user-workflow territory, and the
handoff below documents that boundary so the next owner can pick it up.

## Reproduction model

The task that surfaced the concern has no authoritative bundle metadata:

| Field | Value |
| --- | --- |
| `terminal_backend` | `tmux` |
| `bundle_path` | `(tmux-mode)` |
| `ghostty_bundle_id` | `null` |
| `exec_visible` | `false` |

Trace of what CC does when the user clicks its tree item
(`commandCentral.focusAgentTerminal`, `src/extension.ts:1316`):

1. Launcher-truth gate (`shouldTrustBundleSurface`, `src/extension.ts:143`)
   — allowed (status+backend combo doesn't veto).
2. **Strategy 0** — session-store mapping by `projectDir`. Blocked by
   `taskMatchesSessionStoreBundle` (`src/extension.ts:119`), because
   `task.ghostty_bundle_id == null`. Does not fire. ✅
3. **Strategy 1** — bundle-id focus. Blocked by the `ghostty_bundle_id`
   guard. Does not fire. ✅
4. **Strategy 2** — bundle-path focus. Blocked by the `(tmux-mode)`
   sentinel (`src/extension.ts:1421-1423`). Does not fire. ✅
5. **Strategy 3** — `open -a Ghostty --args -e tmux attach …`
   (`src/extension.ts:1204` before this patch). Fires.
6. CC emits the info message:
   `Opened a fresh Ghostty window attached to tmux session "X" — no
   launcher surface known for this task.`

Strategies 0–2 correctly step aside — the launcher-truth work already
landed by `1a52857`, `cf6dbef`, `98caa1e` holds. The issue is inside
Strategy 3.

## Root-cause hypothesis

### What CC actually does in Strategy 3 (pre-fix)

```ts
execFileAsync("open", [
  "-a", "Ghostty",
  "--args", "-e",
  ...buildTaskTmuxAttachCommand(task), // "tmux", "-f", ..., "-S", ..., "attach", "-t", <session>
]);
```

### Two quiet breakages in that one line

**1. `open -a Ghostty` without `-n` silently drops `--args` when Ghostty
is already running.**

Ghostty's own macOS help text is explicit — see
`/Applications/Ghostty.app/Contents/MacOS/ghostty --help`:

> On macOS, launching the terminal emulator from the CLI is not
> supported and only actions are supported. **Use `open -na Ghostty.app`
> instead**, or `open -na ghostty.app --args --foo=bar --baz=quz` to
> pass arguments.

macOS `open(1)` without `-n` activates an already-running Ghostty and
short-circuits the launch — the Cocoa app never sees `argv`, so
`--args -e tmux attach …` never reaches Ghostty. No new window opens.
The `open` call returns 0 anyway, so CC believes the attach succeeded
and emits: *"Opened a fresh Ghostty window attached to tmux session
X — no launcher surface known for this task."* That message is then
false: no fresh window, no tmux attach, just a generic Ghostty
activation.

From the user's perspective: they click focus, Cmd+Tab now shows the
Ghostty they already had in front (which may be a completely unrelated
prior session), CC tells them a fresh attach just happened. That matches
the "terminal content doesn't match the claimed surface" half of the
report.

**2. `-a Ghostty` is a name lookup, not an identity pin.**

`open -a Ghostty` resolves against LaunchServices by display name.
Stock Ghostty has `CFBundleName="Ghostty"` and launcher bundles don't
(we verified on this machine: `concierge`, `gitscope`, `config`, etc.
each have distinct `CFBundleName` / `CFBundleIdentifier`). So on a
clean LS database, `-a Ghostty` *does* resolve to
`com.mitchellh.ghostty`. But:

- Launcher bundles are clones of `Ghostty.app` and retain
  `CFBundleExecutable="ghostty"`. If a user's LS database gets
  confused (stale cache, renamed bundle, partial rebuild), the lookup
  is no longer guaranteed.
- We have no defense in depth — the only thing between our user and a
  wrong-bundle activation is the launcher's naming discipline. Pinning
  by bundle id removes the name-lookup ambiguity entirely and costs
  nothing.

### What CC does *not* own (the real 🎮 boundary)

The reported "Cmd+Tab still shows the old 🎮 persona" symptom is
**not** a CC focus-routing bug on this task. For a task with
`ghostty_bundle_id=null` and `bundle_path="(tmux-mode)"`, Strategies
0–2 cannot open a 🎮 launcher bundle — they're all gated on bundle
metadata that isn't there. Strategy 3 always targets stock Ghostty.

So where does 🎮 come from? Three plausible non-CC origins, all
outside CC's control:

1. **Stale launcher bundle process.** The user had a 🎮 bundle running
   earlier (from a different project, or an earlier project name).
   Nothing in CC's focus chain brought it forward. Cmd+Tab shows it
   because it's still a running `dev.partnerai.ghostty.<name>` process
   — visible regardless of whether CC clicked anything.
2. **Ghostty Launcher bundle mutation.** The launcher regenerated the
   bundle icon (e.g., project renamed, icon setting changed via
   `ProjectIconManager` / `refreshGhosttyBundleAfterProjectIconChange`,
   `src/ghostty/project-icon-bundle-refresh.ts:18`) but the *running*
   process still has the old icon resident — Cocoa doesn't re-read
   `.icns` on a live process, and `touch`/`lsregister` only refreshes
   LS cache for new launches. The launcher owns deciding when to
   restart bundle processes after icon rewrites.
3. **LaunchServices cache drift.** `lsregister -dump` vs. the real
   `.app` on disk can diverge across Ghostty updates / bundle moves.
   CC has no hook here; `lsregister -kill -r -domain local -domain
   system -domain user` is the manual remedy.

None of these are something CC can fix from inside the focus cascade.
A CC-side *mitigation* would be to re-label the "Cmd+Tab persona"
ambient-awareness story explicitly (e.g., dock-identity-truth probe
before focus), but that's a large piece of work and belongs in the
per-project dock-identity platform line (see
`research/DISSERTATION-cmdtab-platform-2026-03-24.md` §3–5), not as
part of a fix for today's task.

## Evidence

- **Ghostty help text** quoted above, obtained from the installed
  Ghostty binary on this machine
  (`/Applications/Ghostty.app/Contents/MacOS/ghostty --help`). This is
  the source-of-truth for what `open … --args` does on macOS.
- **`lsappinfo` snapshot** confirms two launcher bundles were running
  at investigation time (`dev.partnerai.ghostty.concierge`,
  `dev.partnerai.ghostty.ghostty-launcher`) alongside stock
  `com.mitchellh.ghostty`, each with a distinct foreground process. A
  user Cmd+Tabbing through this set sees three different Ghostty-
  lineage personas — exactly the setup in which a stale persona
  becomes visible without CC doing anything.
- **Bundle-identity audit** on the installed launcher bundles
  confirmed each has a unique `CFBundleName`
  (`plutil -p */Contents/Info.plist`). So `-a Ghostty` *should* hit
  stock today — but the guarantee is fragile.
- **Strategy 3 code path** at `src/extension.ts:1182-1215` (pre-patch)
  showed the missing `-n` flag directly.

## Fix landed in this worktree

`src/extension.ts` (`openGhosttyTmuxAttach`, line range 1182-1224
after patch):

```ts
// Ghostty's own macOS help text: "Use `open -na Ghostty.app` … or
// `open -na ghostty.app --args --foo=bar` to pass arguments."
// Without `-n`, `open -a Ghostty --args …` just activates an already-
// running stock Ghostty and the Cocoa launch is short-circuited —
// `--args -e tmux attach …` is silently discarded, no new window is
// created, and the Strategy 3 "fresh attach" narration becomes false.
// Passing `-n` forces a new stock-Ghostty instance so the attach
// actually runs and the visible surface the user sees is the one we
// just claimed to open. Pinning via `-b com.mitchellh.ghostty`
// avoids any `-a Ghostty` name-lookup ambiguity against a launcher
// bundle whose CFBundleName contains "Ghostty".
await execFileAsync("open", [
  "-n",
  "-b",
  "com.mitchellh.ghostty",
  "--args",
  "-e",
  ...buildTaskTmuxAttachCommand(task),
]);
```

And updated the Strategy 3 inline comment at `src/extension.ts:1447`
to document the new invocation and *why* `-n` is required.

### Why this is the right slice

- It's the smallest possible change that makes our Strategy 3
  narration truthful. No architectural rewrite, no sidecar, no
  cross-repo coordination.
- It aligns CC directly with Ghostty's own documented call
  convention. Future Ghostty changes to this story will land in the
  same help-text slot, so we're coupled to the canonical interface.
- It does **not** claim to fix the stale-🎮-persona symptom — that
  boundary stays where it lives. The handoff below names the next
  owners.

### Side effect worth knowing

`open -n` launches a *new* stock-Ghostty process even if one is
already running. In practice this means the user may end up with
multiple stock Ghostty processes (all sharing `com.mitchellh.ghostty`
— not a 🎮 identity issue). Cmd+Tab typically coalesces them under
one "Ghostty" entry. This is the documented Ghostty-on-macOS recipe
for passing args and matches how Ghostty itself tells integrators to
drive the app, so we're not introducing a new weirdness — we're
removing a silent misbehavior.

### Files changed

- `src/extension.ts` — Strategy 3 `open` args; Strategy 3 inline
  comment.
- `test/commands/extension-commands.test.ts` — narrated Strategy 3
  shape now asserts `-n -b com.mitchellh.ghostty`.
- `test/commands/task-terminal-routing.test.ts` — integration-shape
  test for how `buildTaskTmuxAttachCommand`'s argv composes into the
  `open` invocation now reflects the new arg order.

## Tests run

- `bun test test/commands/extension-commands.test.ts
  test/commands/task-terminal-routing.test.ts` — **78 pass**, 0 fail.
- `just test` — **1412 pass**, 0 fail across 107 files (~5s).
- `node_modules/.bin/biome ci` on the three touched files — clean.
- `just check` — **unrelated** 7 pre-existing errors in
  `src/git-sort/sorted-changes-provider.ts`,
  `src/providers/agent-status-tree-provider.ts`, and
  `test/integration/test-scm-integration.ts` (all `useOptionalChain`,
  all `FIXABLE`). Verified present on `21dc295` before my changes
  (`git stash; just check; git stash pop`). Not this task's scope.

## Boundary & next owners

| Symptom | Owner | Recommended action |
| --- | --- | --- |
| Strategy 3 info message is false (no actual fresh attach) | **Command Central** | ✅ Fixed here (`-n -b com.mitchellh.ghostty`). |
| `-a Ghostty` name-lookup ambiguity vs. launcher bundles | **Command Central** | ✅ Fixed here (bundle id pin). |
| Stale launcher bundle process stays running after project icon change | **Ghostty Launcher** | Decide when the launcher should `kill`/relaunch a bundle whose icon/identity changed. Today CC triggers `createProjectTerminal` via `refreshGhosttyBundleAfterProjectIconChange` but that's best-effort and does not evict already-running processes. |
| Cmd+Tab persona resists refresh after bundle `.icns` rewrite | **Ghostty Launcher + macOS LaunchServices** | Launcher could `lsregister -f <bundle>` on icon rewrite and document a "restart the bundle to see the new icon" user expectation. CC cannot force a running Cocoa app to re-read its `.icns`. |
| Multiple launcher bundles showing ambiguous Cmd+Tab personas at once | **User workflow + per-project dock platform** | Covered by the Phase 2 dock-identity platform plan in `research/DISSERTATION-cmdtab-platform-2026-03-24.md` (NSWorkspace activation watcher, per-project bundle hygiene). Not a focus-cascade fix. |
| Launcher tasks.json ever records a stale `ghostty_bundle_id` that still resolves to a live-but-wrong process | **Ghostty Launcher** (contract writer) + **CC** (consumer, already probes liveness) | CC's `shouldTrustBundleSurface` currently gates on tmux liveness only. Detecting "bundle process is alive but content doesn't match task" would need a bundle-side heartbeat the launcher writes into tasks.json. |

## Should a new prerelease wait on this?

- **Baseline is still `21dc295` (v0.6.0-rc.5).** No competing commits
  have landed on `main`.
- The fix is a pure correctness improvement inside a truthful-narration
  path that already shipped in rc.5. It eliminates a silent narration
  lie when `open -a Ghostty` is called against an already-running stock
  Ghostty, which is a very common state in practice.
- The change is narrow (four-line arg array + comment + two narrated
  tests). It does not touch bundle handling, focus cascade ordering, or
  any running-task state.
- **Recommendation**: roll this into the *next* preview (call it
  `v0.6.0-rc.6`) rather than amending rc.5. Reasons:
  1. rc.5 is already tagged and has presumably been published; amending
     breaks the convention.
  2. The user-visible impact of rc.6 is small but real — Strategy 3's
     fresh-attach claim is now actually true, which tightens the
     truthful-surface contract that rc.4 and rc.5 have been building.
  3. A future "visible-surface truth" dogfood run should drive the next
     cut — it can bundle this fix with any launcher-side work on the
     stale-persona boundary items above.

## Cherry-pick path

This run is in a detached worktree at
`/Users/ostehost/tmp/cc-visible-surface-identity-20260420-1852`
(`gitdir → /Users/ostehost/projects/command-central/.git/worktrees/
cc-visible-surface-identity-20260420-1852`). The fix is a single
conventional-commit patch (see commit below). To land it on `main`:

```bash
cd ~/projects/command-central
git fetch --all
# The commit is reachable from the worktree's HEAD in the same .git:
git log --oneline refs/worktrees/cc-visible-surface-identity-20260420-1852 ^main
# Cherry-pick onto a fresh branch off main
git switch -c fix/strategy-3-ghostty-new-instance main
git cherry-pick <sha-from-worktree>
# Standard PR flow from here
```

If the worktree ref is not visible, use the worktree's HEAD sha directly
(`git -C ~/tmp/cc-visible-surface-identity-20260420-1852 rev-parse HEAD`).

## Related research

- `research/COMMAND-CENTRAL-TRUTHFUL-SURFACE-OPEN-CONTRACT-2026-04-20.md`
  — the Strategy 3 truthful-surface notification work that *just*
  shipped in rc.5. This task is the natural follow-up: the notification
  was truthful about the *intent*, but the `open` call itself wasn't
  actually producing a fresh window when Ghostty was already running,
  so the message was still quietly false in the most common case.
- `research/COMMAND-CENTRAL-FOCUS-TRUTHFUL-LANE-2026-04-20.md` — the
  `shouldTrustBundleSurface` launcher-truth gate.
- `research/DISSERTATION-cmdtab-platform-2026-03-24.md` — full
  per-project dock-identity platform plan; the stale-persona boundary
  items belong in that roadmap, not in the focus cascade.
