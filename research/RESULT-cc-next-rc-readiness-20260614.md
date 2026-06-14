# RESULT — Command Central next RC readiness & local cut

- **Task id:** `cc-next-rc-readiness-20260614`
- **Role:** Implementation agent (visible RC-readiness lane)
- **Date:** 2026-06-14
- **Repo:** `/Users/ostehost/projects/command-central` · branch `main`
- **Host:** `ostehost@MacBookPro.lan` (hub == proof-capable node; `assertNodeExecutionContext` USER=ostehost satisfied)
- **Constraints honored:** local-only — **no push / tag / publish / Marketplace / GitHub release**; no `--no-verify`; no Ghostty Launcher mutation (read-only proof/audit); only the standard install/proof VS Code mutation (`code --install-extension` + a hermetic temp extensions-dir for the proof).

---

## 0. RC verdict

| | |
| --- | --- |
| **Verdict** | 🟢 **CUT_LOCAL_RC** — gates green, no blocker, RC cut + installed + proven locally. |
| **Version before → after** | `0.6.0-rc.63` → **`0.6.0-rc.64`** |
| **Commit created** | `a1b7cddf` — `chore(release): cut local prerelease v0.6.0-rc.64` |
| **Artifact** | `releases/command-central-0.6.0-rc.64.vsix` (279.0 KB, 54 files) · sha256 `625c2d3dd1bb84fa435586317ee26a95d4287f41cf102a2226e7f586febed174` |
| **Installed-VSIX proof** | ✅ PASS (`installed-vsix-agent-status-proof-ok`, exit 0, sha-bound, 47.15s) |
| **Final HEAD** | `a1b7cddf` (48 commits ahead of `origin/main`; nothing pushed) |
| **Final tree** | clean (`git status --porcelain` empty) |

**Why a cut was warranted:** package.json sat at `0.6.0-rc.63`, but HEAD carried **five `fix(agent-status)` commits built after the rc.63 VSIX** — the installed extension was behind the source. The dogfood fixes (tree-identity unification, `.linked` menu-gate survival, stable Symphony root ids, detached-truth rendering) existed in source but had never been packaged/installed/proven. rc.64 closes that gap.

---

## 1. Pre-change inspection (before touching anything)

| Check | Finding |
| --- | --- |
| `git status --porcelain` | clean |
| Branch / HEAD | `main` @ `211f9b2a`, **0 behind / 47 ahead** of origin |
| `package.json` version | `0.6.0-rc.63` |
| Commits since rc.63 release commit (`5c767127`) | `5ad63d14` unify tree identity keys · `0c6ca0d0` scope olderRuns identity to parent · `0372cc37` `.linked` menu-gate survival · `15ecd13a` stable Symphony root ids · `5ef4c4bd` detached truth for liveness-unobservable lanes (+ docs commits) |
| Installed extension | `oste.command-central@0.6.0-rc.63` (behind HEAD) |
| Ghostty Launcher | clean tree @ `a206cabc` (cross-repo provenance OK) |
| Recent handoffs reviewed | installed-VSIX dogfood-proof (`5ef4c4bd` accepted), high-benefit bug hunt (3× P1/P2 fixed, **no open P0/P1**), canonical tree-identity, contract-failure recovery |

**Decision — no unreviewed/blocking local changes:** every post-rc.63 commit is committed and already carries a review/research handoff (the bug-hunt and fixup-recovery lanes ACCEPTED them with failing-before/passing-after tests). Working tree clean, launcher clean → safe to cut.

**Minimum proof identified for the next local RC:** (a) green source gates — targeted Agent Status/tree-view tests + `just check` + strict `just ci`; (b) successful standard prerelease build + content gate + local install; (c) installed-VSIX activation/render proof bound to the freshly built artifact's sha.

---

## 2. Source gates — exact commands & results

| Command | Result |
| --- | --- |
| `just test-unit` | ✅ **641 pass / 0 fail** (129 git-sort + 512 utils/services) |
| `bun test test/tree-view/` | ✅ **495 pass / 0 fail** (1300 expect calls, 26 files) |
| `just check` (biome + tsc + knip) | ✅ exit 0 — tsc clean, knip informational; only the **8 pre-existing** `noNonNullAssertion` warnings in `test/tree-view/agent-status-perf-caches.test.ts` (documented non-blocking) |
| `just ci` (strict gate — warnings=errors; full suite + quality) | ✅ **2143 pass / 1 skip / 0 fail** (~16.5s), quality checks passed (0 `as any`, 0 reflection, 0 skipped-in-active), **CI checks passed** |

The 1 skip is the pre-existing intentional `shell-command.test.ts` property demo.

---

## 3. The cut — standard prerelease flow

```
just cut-preview            # preflight → sync-launcher → rehearsal(just ci) → prerelease(gate → dist --prerelease)
```

- **Preflight:** both repos clean (CC churn within the release-churn allowlist), host `ostehost@MacBookPro.lan`.
- **sync-launcher:** mirrored launcher HEAD `a206cabc` into `resources/bin/**` (byte-identical to the launcher repo — verified `work-system-bridge.sh`, `reaper.sh`).
- **Rehearsal + cross-repo gate:** `just ci` (CC) + `just check` (launcher) + contract checks + provenance artifact — passed.
- **`dist --prerelease`:** bumped `rc.63 → rc.64`, built dev+prod VSIX, **VSIX content gate** passed (compressed 285,654 B / budget 600,000; uncompressed 940,319 B / budget 2,000,000; **54 files** / budget 120; no forbidden artifacts), moved to `releases/`, pruned to last 3, **installed to VS Code**.
- **Lifecycle record:** `just preview-status` → `state: succeeded`, version `0.6.0-rc.64`, artifact sha `625c2d3d…`, exit 0, duration 71.8s.

```
just verify-vscode-consumption --vsix releases/command-central-0.6.0-rc.64.vsix --expected-version 0.6.0-rc.64
  → success: true · installedVersionFromCode 0.6.0-rc.64 · package 0.6.0-rc.64 · sha 625c2d3d…
```

---

## 4. Installed-VSIX Agent Status proof (the render proof)

```
just test-installed-vsix-agent-status \
  --vsix releases/command-central-0.6.0-rc.64.vsix \
  --expected-sha 625c2d3dd1bb84fa435586317ee26a95d4287f41cf102a2226e7f586febed174 \
  --identity-kind published-prerelease \
  --phase quarantine-default
```

✅ **PASS** — `installed-vsix-agent-status-proof-ok`, extension-host exit code 0, 47.15s:

| Field | Value |
| --- | --- |
| phase / mode | `quarantine-default` / passive (hermetic temp extensions-dir, **not** `--extensionDevelopmentPath`) |
| version | **0.6.0-rc.64** (sha-bound to the cut artifact) |
| activation / render | extension active; Symphony roots rendered: `Operations Dashboard | Running Sessions · 2 | Retry Queue · 0 | Workstreams · 0 | Run Attempts · 159` |
| truthfulness | **forbidden launcher hits: 0** (no fake rows / no disguised subagents); 28 `project_ref`-less legacy rows correctly **quarantined** (11 from `lanes.json`, 17 from launcher `tasks.json`) |
| actions | 0 passed / 3 skipped (passive phase makes no action claims) |
| manifest | `logs/installed-vsix-agent-status-proof-1781479354093-quarantine.json` |

This proves the **rc.64 artifact** (not merely "an" extension) activates and renders the live Agent Status / Symphony tree against the real operator registries, agent-/model-neutrally, with no synthetic running state.

---

## 5. Installed-VSIX proof on the release path — audit

**Finding (gap confirmed, unchanged from the prior dogfood handoff §3):** the installed-VSIX **render** proof is still **NOT** auto-wired into `cut-preview`. The release path proves source contracts (`prerelease-gate`, before any VSIX exists) and VSIX **content** (`vsix-content-gate` inside `dist`), but nothing on the path asserts the installed VSIX **activates + renders**. `test-installed-vsix-agent-status` / `verify-vscode-consumption` remain separate, node-gated, manual recipes (printed only as "next steps").

**Action taken — ran it manually + documented (did not auto-wire):** I executed the proof by hand against this RC's sha (§4) rather than editing the recipe. The recommended `release-proof <vsix>` recipe is **deliberately deferred**: wiring it requires an off-node **skip-vs-fail policy** decision (the proof is node-gated + heavy — it would hard-fail any non-`ostehost` machine/CI), which is a release-policy judgment for Oste, not a "small safe" edit. Auto-wiring it now would also risk a silent-pass anti-pattern off-node. So the truthful state is: **proof run + green for rc.64, gap on the automated path remains open by design** pending that decision. The exact integration plan already lives in `research/RESULT-cc-installed-vsix-dogfood-proof-20260614.md` §3.

---

## 6. Files changed (commit `a1b7cddf`)

Release churn only — all within the `cut-preview` release-churn allowlist; staged by explicit path (not `git add -A`, per the concurrent-lane sweep hazard):

```
package.json                                            (version 0.6.0-rc.63 → 0.6.0-rc.64)
releases/digest-v0.6.0-rc.64.md                         (new digest)
research/prerelease-gate/latest.json                    (gate record)
research/prerelease-gate/prerelease-gate-2026-06-14T23-21-28.820Z.json  (new gate provenance)
resources/bin/ghostty-launcher                          (sync-launcher mirror of launcher a206cabc)
resources/bin/scripts/lib/{bundle-runtime,oste-stop-hook,reaper,tasks-lock,work-system-bridge}.sh
10 files changed, 515 insertions(+), 77 deletions(-)
```

Biome pre-commit hook passed. No `--no-verify`. (VSIX files are `.gitignore`'d — the digest is the tracked record.)

---

## 7. Remaining dogfood dependencies

| Item | Status |
| --- | --- |
| **B1 — Discord channel gate** (writer gateway) | ✅ Live-proven green via native OpenClaw create→verify→delete cleanup (per Oste context). |
| **B2 — orchestrator `ensureWorkroom` emission + end-to-end prep** | ⛔ **Open** — next dogfood work; not a CC-source blocker for this local RC. |
| **Installed-VSIX render gate on `cut-preview`** (`release-proof` recipe) | ⛔ **Open by design** — pending Oste's off-node skip-vs-fail policy (§5). Plan ready; not wired. |
| **Live visual dogfood pass** (human confirms spinner→`debug-disconnect`/`(detached)` on a real launcher row with `attach.available:false`) | ⛔ **Recommended** — the rc.64 proof confirms render + truthfulness via API snapshot; a visible-VS-Code eyeball pass on a detached lane is still worth a human/authorized lane. |
| Optional: generalize detached path beyond `lane_projection` to session-less **daemon** primary rows | ⚪ Optional follow-up (currently scoped to projection rows for provable safety). |

None of the open items block this **local** RC — they are forward dogfood/release-automation work.

---

## 8. Final state

```
HEAD:                    a1b7cddf chore(release): cut local prerelease v0.6.0-rc.64
parent:                  211f9b2a docs(research): full implementation handoff for cc-installed-vsix-dogfood-proof-20260614
git status --porcelain:  clean
ahead of origin/main:    48 commits (nothing pushed)
package.json version:    0.6.0-rc.64
installed extension:     oste.command-central@0.6.0-rc.64
preview-status:          succeeded · sha 625c2d3d… · exit 0
```

Nothing pushed, tagged, published, or released to GitHub/Marketplace. Ghostty Launcher untouched (read-only proof/audit). Exiting normally so the launcher writes the pending-review receipt.

---

## 9. Recommended next lane

1. **Decide the off-node skip-vs-fail policy** for `release-proof`, then wire it into `cut-preview` after `just prerelease` (loud off-node deferral, never silent pass).
2. **B2 orchestrator `ensureWorkroom`** emission + end-to-end dogfood prep.
3. Optional human **visible-VS-Code** dogfood pass confirming the detached-truth render on a live `attach.available:false` launcher row.
