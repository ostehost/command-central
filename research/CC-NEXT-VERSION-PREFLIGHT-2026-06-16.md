# Command Central — Next-Version Preflight (rc.66)

- **Task id:** `cc-next-version-preflight-20260616`
- **Date:** 2026-06-16
- **Role:** release / preflight engineer
- **Machine:** `ostehost@MacBookPro` (hub; satisfies node-execution guard)
- **Repo:** `/Users/ostehost/projects/command-central` @ branch `main`
- **Outcome:** ✅ Local prerelease **v0.6.0-rc.66** cut, built, installed, and committed locally. **No push / tag / marketplace publish / GitHub release.**

---

## 1. Version before / after

| | Version |
| --- | --- |
| **Before** | `0.6.0-rc.65` |
| **After** | `0.6.0-rc.66` |

Bump performed by `npm version prerelease --no-git-tag-version` (inside `scripts-v2/dist-simple.ts`) — **no git tag created**. `package.json` is the source of truth.

### Commits captured by this RC (already on `main`, local-only, 55 ahead of `origin/main`)
- `eb28320d` fix(agent-status): surface terminal-but-alive lanes as live attention required
- `56709213` feat(agent-status): guard stale pre-reset Ghostty apps from reading as live
- `03e27436` feat(agent-status): wire release-generation source from launcher app_stamp baseline

> Note: `43543c72 chore(release): cut local prerelease v0.6.0-rc.65` landed **before** the three feature commits above, so rc.65 did not contain them. rc.66 is the first cut that bundles all three.

---

## 2. Commands run (in order)

| Command | Result |
| --- | --- |
| `git status` / inspection of `package.json`, `justfile`, `scripts-v2/dist-simple.ts`, `scripts-v2/prerelease-gate.ts` | clean tree; safety verified (no publish/push/tag in the release path) |
| `just cut-preview` | ✅ full local-only preview flow (preflight → sync-launcher → CI rehearsal → prerelease gate → `dist --prerelease`) |
| `just verify-vscode-consumption --vsix releases/command-central-0.6.0-rc.66.vsix --expected-version 0.6.0-rc.66` | ✅ `success: true` |
| `just test-installed-vsix-agent-status` (passive, real VS Code via test-electron) | ⚠️ failed — **environmental false-positive**, see §5 |
| `git add -- <release churn paths>` + `git commit` | ✅ commit `cc783b4f` (Biome pre-commit hook passed) |

### `just cut-preview` breakdown
- **Preflight:** both repos clean; host = hub (`ostehost`). ✓
- **sync-launcher:** refreshed 4 bundled launcher helper scripts in `resources/bin/scripts/lib/` (writes only into CC resources — the launcher repo was **not** modified). ✓
- **CI rehearsal (`just ci`):** Biome ci + tsc + knip + coverage + test-quality. **2183 pass / 1 skip / 0 fail** across 153 files (17.4s). ✓
- **Prerelease gate (`scripts-v2/prerelease-gate.ts`):** CC `just ci` + ghostty-launcher `just check` + cross-repo launcher/steer contract checks + launcher CLI sanity. **✅ passed.** Artifact: `research/prerelease-gate/prerelease-gate-2026-06-16T05-48-07.501Z.json`.
- **`dist --prerelease`:** version bump → build dev+prod VSIX → VSIX content gate → install to VS Code → digest.

---

## 3. Tests & gates

| Gate | Result |
| --- | --- |
| `just ci` (Biome + tsc + knip + coverage + quality) | ✅ 2183 pass / 1 skip / 0 fail |
| Cross-repo prerelease gate (CC + launcher + contract) | ✅ passed |
| VSIX content gate | ✅ 288,283 B compressed (budget 600k) / 948,018 B uncompressed (budget 2M) / 54 files (budget 120); no forbidden artifacts |
| `verify-vscode-consumption` | ✅ installed == package == VSIX identity `oste.command-central@0.6.0-rc.66` |
| Passive installed-VSIX Agent Status proof | ⚠️ 1 false-positive (see §5) — not a code regression |

---

## 4. Install proof — the new `commandCentral.releaseGeneration.file` setting

The setting and its read-path are present in **both** the built VSIX and the installed extension.

**Source (`package.json:230`)** — setting declared with default `~/.config/ghostty-launcher/release-generation.json`, `OSTE_RELEASE_GENERATION_FILE` env override, `scope: machine`.

**Built VSIX `releases/command-central-0.6.0-rc.66.vsix`:**
- `extension/package.json` contains `commandCentral.releaseGeneration.file` ✓
- `extension/dist/extension.js` (minified, compiled) contains the read-path symbols: `releaseGeneration.file`, `OSTE_RELEASE_GENERATION_FILE`, `app_stamp`, `stale (pre-release)` ✓

**Installed extension `~/.vscode/extensions/oste.command-central-0.6.0-rc.66/`:**
- `package.json` contains `commandCentral.releaseGeneration.file` ✓
- `dist/extension.js` contains `releaseGeneration` read-path ✓

**Consumption check:** `verify-vscode-consumption` → `success: true`
- `installedVersionFromCode: 0.6.0-rc.66`
- `installedPackageVersion: 0.6.0-rc.66`
- `vsixIdentity: oste / command-central / 0.6.0-rc.66`
- `vsixSha256: 154643ac05fcd0b5d284e98762d31636b2201d04b2778322f375f7cadae7d435`

> VS Code still needs a manual **Developer: Reload Window** to activate rc.66 in any already-open window (standard for an install over a running instance).

---

## 5. Remaining risks

### R1 — Passive installed-VSIX proof false-positive (NOT a release blocker)
`just test-installed-vsix-agent-status` (passive mode, real VS Code) reported:

```
Forbidden launcher task id surfaced as launcher data:
  ghostty-project-ref-laneref-20260611 (nodeKind=task)
  on "🧊 🔍 review-ghostty-project-ref-laneref-20260611" [task]
```

**Root cause (a pre-existing proof fragility × live-registry residue, independent of rc.66):**
1. The proof reads the **live** registries (`~/.config/openclaw/lanes.json`, `~/.config/ghostty-launcher/tasks.json`) — 206 launcher tasks on this machine.
2. The runner derives `quarantineForbiddenIds` from live **stale** ids (records with **no `project_ref`**). The base id `ghostty-project-ref-laneref-20260611` exists in `tasks.json` with `project_ref = null`, status `completed` → classified stale → added to the forbidden list. (`runInstalledVsixAgentStatusProof.ts:526-533`)
3. A sibling lane `review-ghostty-project-ref-laneref-20260611` **does** carry a valid active `project_ref` (Ghostty Launcher) and legitimately surfaces as a completed LaneRef lane.
4. The forbidden sweep matches via `nodeMatchesTaskId` → `node.label.includes(taskId)` — a **substring** match (`installed-vsix-proof-shared.ts:126`). The legitimately-surfaced `review-…` label **contains** the forbidden base id as a substring → false-positive hit.

**Why it is not a regression from this RC:** the three commits touch only `src/providers/agent-status-tree-provider.ts`, `src/providers/agent-task-classification.ts`, and `test/.../agent-status-live-terminal-state.test.ts`. None touch the quarantine/`project_ref` admission path, the forbidden sweep, or `nodeMatchesTaskId`. The same assertion would fire identically on rc.65 against today's live registry. The failure is data-dependent on leftover 2026-06-11 project_ref/laneref dev lanes sitting in the live launcher registry.

**Why no cleanup was performed:** removing the residue means mutating the live launcher registry (`~/.config/ghostty-launcher/tasks.json`) — out of scope under this task's hard constraints (no external mutation; do not edit Launcher/Symphony/OpenClaw).

**Recommended follow-ups (separate task):**
- Tighten the forbidden sweep so a quarantined id that is a **substring** of a lane-backed id does not produce a hit (e.g. exact-id / word-boundary match in `nodeMatchesTaskId`, or exclude forbidden ids that are substrings of `realLaneBackedIds`).
- Optionally reap the completed `ghostty-project-ref-laneref-20260611` / `review-…` residue from the live launcher registry (launcher-owned hygiene task).

Quarantine manifest (gitignored, local): `logs/installed-vsix-agent-status-proof-1781588992039-quarantine.json`.

### R2 — Local-only, unpushed
`main` is **55 commits ahead of `origin/main`** (long-standing local-only working state). rc.66 + this preflight remain local. Pushing/tagging/publishing is Tier 2 and intentionally **not** done.

### R3 — Reload required
Already-open VS Code windows run rc.65 until **Developer: Reload Window**.

---

## 6. Did a local version bump / commit happen?

**Yes.**
- `package.json` bumped `0.6.0-rc.65` → `0.6.0-rc.66` (no git tag).
- Release churn committed as **`cc783b4f`** `chore(release): cut local prerelease v0.6.0-rc.66`:
  - `package.json` (version)
  - `releases/digest-v0.6.0-rc.66.md` (digest)
  - `research/prerelease-gate/latest.json` + dated gate artifact (provenance)
  - `resources/bin/scripts/lib/{bundle-runtime,oste-task-completed-hook,pending-review,work-system-bridge}.sh` (sync-launcher refresh)
- This handoff committed separately as `docs(research): …`.
- The built VSIX `releases/command-central-0.6.0-rc.66.vsix` is **gitignored** (`*.vsix`), as is the convention — only the digest + provenance are tracked. rc.63 VSIX was evicted (keep-last-3).

Staging was path-scoped (no `git add -A`) to avoid sweeping sibling-lane edits into this commit.

---

## 7. Constraint compliance

| Constraint | Status |
| --- | --- |
| No push | ✅ not done |
| No git tag | ✅ `--no-git-tag-version` |
| No marketplace publish | ✅ no `vsce publish` |
| No GitHub release | ✅ none |
| No external mutation | ✅ only local build/install + local commit; live registry untouched |
| Do not edit Launcher/Symphony/OpenClaw | ✅ launcher read-only; sync wrote only into CC `resources/bin/` |
| No `--no-verify` | ✅ Biome pre-commit hook ran and passed |

---

## 8. Suggested next steps for the operator
1. Open/focus VS Code → **Developer: Reload Window** to activate rc.66.
2. Smoke-test Agent Status (live-terminal badging + `stale (pre-release)` behavior once the launcher stamps `release-generation.json`).
3. `just preview-status` to confirm the cut lifecycle record reads `SUCCEEDED`.
4. (Optional) Address R1 proof fragility in a dedicated task before relying on the passive installed-VSIX proof as a release gate.
5. Push/tag/publish remain operator-driven (Tier 2) — not performed here.
