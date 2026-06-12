# RESULT — Next RC installed-VSIX UI proof (Work System lane-projection stack)

- **Task**: `cc-next-rc-installed-ui-proof-20260612`
- **Date**: 2026-06-12
- **Role**: developer/proof
- **Verdict**: **Ready for Mike dogfood** (rc.59; local only — no push/tag/publish)

## Artifact

| Field | Value |
|-------|-------|
| Dogfood candidate | **v0.6.0-rc.59** |
| VSIX | `releases/command-central-0.6.0-rc.59.vsix` (273.0 KB, content gate passed) |
| VSIX sha256 | `d596dff36160c2fece6562e194808c52f51282e35f6a86232f883b1267023e03` |
| Built from | `0fc1dc75` (fix) on top of `05b5616c` (task start HEAD) |
| Final HEAD | this receipt's commit, on top of `2fb7132b` (series: `05b5616c` start → `0fc1dc75` fix → `2fb7132b` release churn → receipt) |
| Superseded | v0.6.0-rc.58 (`c8cbc566ca96…6c21b578`, built from `05b5616c`) — cut first, then superseded same-session by the liveness fix below |
| Launcher dependency | ghostty-launcher `418e34d4` (dogfood review receipt committed to unblock preflight; clean tree) |

## Commands and exit codes

| Command | Exit | Result |
|---------|------|--------|
| `just cut-preview --prerelease` (rc.58) | 0 | preflight + sync-launcher + `just ci` rehearsal + cross-repo gate + dist |
| `just verify-vscode-consumption --vsix …rc.58 --expected-version 0.6.0-rc.58` | 0 | normal VS Code profile consumes rc.58 |
| `just test-installed-vsix-agent-status` (rc.58, both phases) | 0 | passed, but live lane rendered **Stopped** (see bug) |
| Quarantine rerun from non-descendant tmux server (rc.58) | 0 | live lane rendered **Running** — diagnosis confirmed |
| `just ready` (after fix) | 0 | 2024 pass / 0 fail / 1 skip; biome + tsc + knip clean |
| `just cut-preview --prerelease` (rc.59) | 0 | full gate again on `0fc1dc75` |
| `just verify-vscode-consumption --vsix …rc.59 --expected-version 0.6.0-rc.59` | 0 | normal profile consumes rc.59, sha match |
| `just test-installed-vsix-agent-status` (rc.59, both phases, self-observing) | 0 | live lane renders **Running** — fix proven in installed artifact |
| Staged-projection quarantine run (rc.59) | 0 | `work-system-lanes-projection` ingested in installed extension |
| `bun test test/integration/worksystem-lanes-projection.test.ts` | 0 | 10 pass / 0 fail / 55 expect() |

Proof manifests (gitignored `logs/`, retained on disk):
`installed-vsix-agent-status-proof-rc58-20260612-{quarantine,legacy}.json`,
`…-rc58-nondesc-quarantine.json`, `…-rc59-20260612-{quarantine,legacy}.json`,
`…-rc59-projection-quarantine.json`. Each pins version, VSIX sha256, commit,
tree snapshots, and `errors: []`.

## Bug found and fixed: pgrep ancestor exclusion falsely demoted live lanes

The rc.58 installed proof showed this task's genuinely-running lane as
"Stopped · ⚠ detached". Root cause (confirmed via `man pgrep` and probes from
descendant vs non-descendant processes): **BSD/macOS pgrep excludes the calling
process and all of its ancestors from matches by default**. The proof's
extension host is a descendant of the lane it observes, so
`walkDescendants` → `pgrep -P <pane_pid>` exited 1 ("no children" — treated as
proof of absence per the liveness invariant) for the lane's own live chain
`fish → bash → bash → claude`, flipping evidence to `dead` and demoting the
lane to stopped. The identical probe from a non-descendant process returned the
chain and the lane rendered Running.

Fix (`0fc1dc75`): pass `-a` ("include process ancestors in the match list") in
`src/utils/tmux-pane-health.ts:221`; regression test asserts every descendant
walk passes `-a`. On Linux procps `-a` only appends the command line to output
rows, which the pid parse tolerates. This affected any self-observing context
(installed proof harness run from an OpenClaw lane, VS Code launched from an
agent terminal) — it also blinded discovery (`Running Sessions · 0` → `1` after
fix). The `⚠ detached` tag itself is unrelated completion-routing metadata (no
`session_key`/`callback_url` at launch) and is correct.

## Carry-forward checks from the accepted Ghostty→CC dogfood review

1. **Discovery interplay enabled** — ✓. Quarantine-default phase writes `{}`
   settings; shipped default `commandCentral.discovery.enabled: true` applies
   (verified in package.json contributes). Discovery ran live in the installed
   extension and surfaced the real session (`Running Sessions · 1`), merging
   with lane-registry records without duplication.
2. **At least one `running` lane visible** — ✓, twice over, with zero staging
   for the first: this task's own lane (`cc-next-rc-installed-ui-proof-20260612`,
   `status=running`, `project_ref.id=command-central`) was already a live record
   in the real default registry `~/.config/ghostty-launcher/tasks.json` and
   rendered **Running** in Symphony (`Running Sessions`, `Run Attempts`) and
   Agent Status (`Running · 1 agent`) in the rc.59 proof. The staged projection
   run added a second Running lane sourced from the projection itself.
3. **Cosmetic "loaded N from N registries" count** — ✓ observed, not misread:
   the log said "loaded 51 launcher tasks from **2** task registries" while
   `~/.config/openclaw/lanes.json` was absent — it counts configured sources,
   not existing files. All 51 lane-backed records came from `tasks.json`.

## Required proof coverage

- **Installed VSIX from current HEAD** — rc.59 built from `0fc1dc75`; manifests
  pin `commit: 0fc1dc75…`, `vsix_sha256: d596dff3…`; suite asserts the
  extension did NOT load from `--extensionDevelopmentPath`.
- **Agent Status loads with discovery enabled** — pristine-default phase,
  activation asserted, `errors: []`.
- **Default lane-registry path includes `~/.config/openclaw/lanes.json`** —
  the quarantine phase hard-asserts both providers resolve exactly
  `[~/.config/openclaw/lanes.json, ~/.config/ghostty-launcher/tasks.json]`
  under default settings (zero-config contract); resolvedFilePaths in every
  manifest confirm it.
- **Projection reader handles `work-system-lanes-projection`** — staged run:
  emitted a projection envelope with the **production bridge libraries**
  (`work-system-bridge.sh` outbox mode, real read-only Work Registry resolver)
  containing (a) a truthful mirror of this task's live lane and (b) a
  projection-only sentinel (`cc-rc59-projection-proof-sentinel-20260612`,
  `release-proof` → canonical `review` + `lane_kind_source` retained); staged
  the bytes at the real `~/.config/openclaw/lanes.json`; installed rc.59
  ingested it through the default path: sentinel rendered
  "Running · … · work-system-lanes-projection · tmux", the mirrored lane
  appeared **exactly once** (projection deduped against the primary record,
  task count 52 = 51 + sentinel), `errors: []`. File deleted afterward;
  absence verified (pre-task state restored). Reader source unchanged since
  the dogfood-reviewed commit (only `openclaw-gateway-health.ts` differs by
  one line). Focused suite: 10/10.
- **Stale-row quarantine** — 17 launcher-era records without `project_ref`
  stayed hidden in every run (`forbidden launcher hits: 0`).
- **Legacy escape hatch** — fixture phase: 2/2 running sentinel tasks visible
  via explicit `legacyLauncherTasks.enabled` + `agentTasksFile` settings.

## State and contamination notes

- Working tree: clean (`git status --porcelain` empty) at receipt time.
- No push, no tags, no Marketplace publish, no Linear/Discord, no operator
  state cleared. External network: none beyond local toolchain (VS Code test
  build pinned to cached 1.124.0; no download).
- `~/.config/openclaw/lanes.json`: absent before, absent after. The ~60s
  staging window was visible to the operator's real VS Code (truthful mirror
  of this lane + one clearly-named sentinel); both disappeared on cleanup via
  the file watcher.
- Ghostty Launcher: committed `418e34d4` (untracked accepted review receipt —
  direct release-path dependency blocking `cut-preview` preflight).
- rc.59 is installed in the normal VS Code profile; **Mike should
  `Developer: Reload Window`** to activate it.

## Remaining blockers / next steps

- **None blocking dogfood.** Next step: **Mike dogfood of rc.59** (not public
  release).
- Non-blocking observations for the dogfood:
  - "possibly stuck" tag can appear on an interactive Running lane whose JSONL
    stream is silent; cosmetic heuristic, not a status change.
  - The legacy-fixture phase emits `can't find session` stderr from tmux for
    fabricated fixture sessions — expected probe noise, not a failure.
  - `releases/` retention keeps 3 VSIXes; rc.54 was auto-pruned, rc.58 VSIX
    remains on disk but rc.59 supersedes it.
