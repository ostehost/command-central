# RESULT — Command Central dogfood-proof blockers: installed-VSIX gate, projection row truthfulness, launcher visibility consumer contract

- **Task id:** `cc-installed-vsix-dogfood-proof-20260614`
- **Role:** Implementation agent (visible blocker-investigation lane)
- **Date:** 2026-06-14
- **Repo:** `/Users/ostehost/projects/command-central` · branch `main`
- **Implementation commit:** `5ef4c4bd` — `fix(agent-status): render detached truth for liveness-unobservable running lanes`
- **Working tree:** clean before this handoff commit (`git status --porcelain` empty)
- **Constraints honored:** no install / publish / tag; no `--no-verify`; no fake rows; no synthetic running state; VS Code–native only.

> **Concurrent-lane note:** a sibling *contract-failure recovery* lane ran in this shared
> working copy and independently reviewed + ACCEPTED commit `5ef4c4bd`, writing the
> canonical review at
> [`RESULT-cc-installed-vsix-dogfood-proof-fixup-20260614.md`](./RESULT-cc-installed-vsix-dogfood-proof-fixup-20260614.md).
> This file is the implementation lane's full deliverable (GO/NO_GO, blocker #1 gate plan,
> live cross-repo confirmation, test matrix) — a superset of the earlier thin recovery
> pointer it replaces. Both are kept; neither lane used `git add -A`.

---

## 0. TL;DR / Verdict

| Blocker | Verdict | Outcome |
| --- | --- | --- |
| **#2 projection row truthfulness** (spinner with zero liveness) | 🟢 **GO — fixed** | Session-less projection `running` lanes (and launcher-flagged ones) now render a static `debug-disconnect` "(detached)" visual instead of the animated `sync~spin` spinner. Anti-flap rule preserved. |
| **#3 launcher visibility/degraded consumer contract** | 🟢 **GO — fixed (live gap, not future-proofing)** | CC now ingests + consumes the launcher's `attach`/`visibility` projection. The live `~/.config/openclaw/lanes.json` (105 lanes) **already** carries `attach` on every lane; CC was dropping it. |
| **#1 installed-VSIX activation/render proof on release path** | 🟡 **NO_GO to auto-wire — precise plan delivered** | Deliberately not wired into the release recipe (heavy, node-gated electron proof; "do not install/publish" scope). Exact gate-integration plan in §3. |

One focused implementation commit (`5ef4c4bd`). Both implemented blockers ship with failing-before / passing-after regression tests. Full suite **2143 pass / 0 fail / 1 pre-existing skip**.

---

## 1. What I changed (blockers #2 + #3, unified)

Blockers #2 and #3 are the same truth from two angles, so one coherent change covers both. All in `src/providers/agent-status-tree-provider.ts` + two test files.

### 1a. New static classifier — `isLivenessUnobservableRunningLane(task)`
A `running` lane whose live work CC **cannot substantiate** must not render the spinner. Two truth sources, in order:

1. **Launcher-projected evidence (preferred):** `attach.available === false` (no attachable terminal at emission) or `visibility.degraded === true` (a visible lane that failed its on-screen verification). These ride the `lane_ref_update` envelope.
2. **Structural fallback (local):** a non-authoritative projection row (`lane_projection === true`) emitted **session-less** — `laneRefUpdateToTaskRecord` falls the session id back to `launcher:<task_id>`, which fails `isValidSessionId` by construction, so there is no tmux session / pane / pid for CC to probe.

Remote-node lanes are **always excluded** (host can't be verified locally → fail-open, never demoted — mirrors `isRemoteNodeTaskForCurrentHost` usage in `isRunningTaskHealthy`).

### 1b. Call-site gate (runtime) in `createTaskItem`
```
livenessUnobservable = isLivenessUnobservableRunningLane(task) && !this.hasPositiveLivenessEvidence(task)
```
The runtime gate means a projection lane whose worktree actually hosts a **discovered live agent**, or a launcher-flagged row CC can **locally confirm alive** (live tmux probe), keeps its spinner. This is what preserves the deliberate anti-flap doctrine: a session-backed lane with merely **inconclusive ("unknown")** local pane evidence still renders `sync~spin` (proven by the untouched test `agent-status-launcher-interactive-claude.test.ts:261`).

### 1c. Rendering
- **Icon:** new branch — `debug-disconnect` (charts.yellow), inserted after lifecycle-conflict, before the stale/stuck branch.
- **Description:** `(detached)` suffix (takes precedence over `(possibly stuck)` / `(interactive)`).
- **Tooltip:** a `$(debug-disconnect) Liveness: Detached — running state not locally observable (<reason>)` line, citing `visibility.reason` / `attach.reason_if_unavailable` when present.
- **Status & grouping UNCHANGED** — detached is a *visibility* badge, not a lifecycle state (consistent with the established doctrine in `agent-status-running-detached-surface.test.ts`).

### 1d. Launcher attach/visibility ingestion (blocker #3 consumer contract)
- Added 4 optional fields to `AgentTask`: `launcher_attach_available`, `launcher_attach_reason`, `launcher_visibility_degraded`, `launcher_visibility_reason`.
- `laneRefUpdateToTaskRecord` now maps the envelope-level `attach` (`available`, `reason_if_unavailable`) and `visibility` (`degraded`, `reason`) objects — per `ghostty-launcher/scripts/laneref-update-schema.json` §attach/§visibility. **These were previously dropped on ingest.**
- `normalizeTask` preserves them (so primary-registry rows carrying them survive too); added `asNullableBoolean` / `asRecord` parse helpers.
- Forward-compatible: absent objects → `null` fields, ingestion unaffected (loose-enum / ignore-unknown philosophy preserved).

---

## 2. Why a classifier + runtime gate (not a naive "no-evidence → no-spinner")

The codebase has a **deliberate, tested** anti-flap rule: when CC's own local probe is *inconclusive* (`unknown` tmux pane evidence on a fresh running lane), it **keeps the spinner** so it "does not overclaim certainty" (`agent-status-launcher-interactive-claude.test.ts:261-288`; see also `HANDOFF-agent-status-pane-liveness-fix-2026-05-27.md` — "treat transient pgrep failures as unknown, not dead"). The fix threads between that rule and the new truth:

- **"unknown" probe** (a channel exists but the answer is inconclusive) → keep spinner. *Unchanged.*
- **"no channel at all"** (session-less projection) **or "launcher says unavailable/degraded"** → detached. *New.*

These are genuinely different states, so the change is additive and provably scoped: it cannot affect any session-backed launcher/discovery row, the bulk of the tree.

---

## 3. Blocker #1 — installed-VSIX activation/render proof on the release path (precise plan)

### Current state (audited)
- Proof harness: `test/integration/runInstalledVsixAgentStatusProof.ts` (+ `installed-vsix-proof-suite.ts`, `-shared.ts`). It installs the VSIX into a **hermetic temp extensions-dir** (NOT real VS Code), downloads VS Code via `@vscode/test-electron`, **activates** the installed extension, asserts `extension.isActive`, version match, *not* loaded from `--extensionDevelopmentPath`, and renders the Symphony/Agent-Status trees. Two phases (`quarantine-default`, `legacy-fixture`), passive by default. Gated by `assertNodeExecutionContext()` (USER=ostehost).
- Consumption check: `scripts-v2/verify-vscode-extension-consumption.ts` (cheap; `code --list-extensions` + installed package version + sha).
- Release path: `cut-preview` → `_preview-preflight` → `sync-launcher` → `_preview-rehearsal (just ci)` → `prerelease` = `prerelease-gate.ts` **then** `dist --prerelease`.
- `dist-simple.ts` builds dev+prod VSIX, runs the **content** gate (`vsix-content-gate.ts`: size/file-count/dev-artifact leaks), moves to `releases/`, and `code --install-extension`s it.

### The gap
`prerelease-gate.ts` runs **before** `dist` (no VSIX exists yet) and validates source contracts only. `dist` proves the VSIX's *content* and installs it, but **nothing on the release path proves the installed VSIX actually activates and renders**. `test-installed-vsix-agent-status` + `verify-vscode-consumption` are separate, manual, node-gated recipes (they appear only as manual "next steps" in `cut-preview`'s printed checklist).

### Why I did not auto-wire it
1. The proof needs a **built VSIX** → must run *after* `dist`, so it cannot live in `prerelease-gate.ts`.
2. It is **node-gated** (`assertNodeExecutionContext` throws unless USER=ostehost) and **heavy** (downloads VS Code, ~40s electron run). Dropping it unconditionally into `cut-preview` would **hard-fail** on any non-node machine / CI.
3. Scope: "safe local fixes/tests only; do not install/publish/tag." The skip-vs-fail policy for off-node cuts is a release-policy judgment for Oste, not a blind edit.

### Exact integration recommendation
Add a new recipe `release-proof <vsix>` and invoke it from `cut-preview` **after** `just prerelease`, guarded so it runs on the node and **logs a loud, explicit deferral** (never a silent pass) off-node:

```
release-proof vsix="":            # resolve newest releases/*.vsix if empty
    # 1. node-context detect → if not node: print "⚠ installed-VSIX render proof DEFERRED to node" and exit 0
    # 2. just verify-vscode-consumption --vsix <vsix> --expected-version <pkg.version>
    # 3. COMMAND_CENTRAL_EXPECTED_VSIX_SHA256=<sha> COMMAND_CENTRAL_EXPECTED_VSIX_IDENTITY_KIND=published-prerelease \
    #    just test-installed-vsix-agent-status --phase quarantine-default   # passive, hermetic, sha-bound
```
- Bind the proof to the freshly built VSIX's sha (`COMMAND_CENTRAL_EXPECTED_VSIX_SHA256` + `--identity-kind`) so the gate proves *that artifact* activates/renders, not just *an* extension.
- Use `--phase quarantine-default` (passive) for the gate; reserve `--live --phase legacy-fixture` (with `COMMAND_CENTRAL_REQUIRED_TASK_ID`) for the deeper manual proof.
- The off-node deferral must be **loud** (echoed + recorded), per the "no silent fallbacks" doctrine — a deferred proof must never read as a passed proof.

This is the smallest change that makes "the release built/installed *and proved render*" true, without making cuts impossible off-node and without auto-installing/publishing.

---

## 4. Cross-repo dependencies

| Item | Status |
| --- | --- |
| Launcher emits `attach`/`visibility` on `lane_ref_update` | ✅ **Already shipped.** `ghostty-launcher/scripts/lib/work-system-bridge.sh:333-391` builds the `attach` object (available/reason_if_unavailable); `visibility` documented + emitted for visible-bundle lanes. |
| Launcher projects them into the read-model | ✅ **Confirmed live.** `~/.config/openclaw/lanes.json` (kind `work-system-lanes-projection`, 105 lanes) carries `attach` on **105/105** lanes; sample: `attach.available:false, reason_if_unavailable:"tmux-session-not-found"`, `visibility:null`. CC was dropping all of it until this change. |
| `visibility` populated for tmux/headless lanes | ⚠️ **By design null** — the launcher only probes visibility for *visible-bundle* lanes; tmux/headless make no claim. So `attach.available` is the primary live signal CC consumes; `visibility.degraded` applies to visible-bundle lanes. |
| Installed-VSIX render gate on release path | ⛔ **Pending Oste decision** on the skip-vs-fail policy (see §3) before wiring `release-proof` into `cut-preview`. |
| Live installed-VSIX visual dogfood pass | ⛔ **Out of scope here** (no-publish/no-install lane). A human/authorized release lane should confirm the spinner→`debug-disconnect` swap renders on a real launcher row carrying `attach.available:false`. |

No launcher edits were required to unblock CC — the launcher contract was already ahead of the consumer.

---

## 5. Tests

| Command | Result |
| --- | --- |
| `bun test test/tree-view/agent-status-running-detached-surface.test.ts` | **14 pass / 0 fail** (4 pre-existing + 10 new: 7 pure-classifier branches, 3 provider-render) |
| `bun test test/integration/worksystem-lanes-projection.test.ts` | **12 pass / 0 fail** (10 pre-existing + 2 new: attach/visibility ingestion round-trip, forward-compat absence) |
| `bun test test/tree-view/` (full dir) | **495 pass / 0 fail** (incl. the unchanged anti-flap unknown-keeps-spinner test) |
| `just test-unit` | **641 pass / 0 fail** (129 git-sort + 512 utils/services) |
| `just check` | ✅ biome ci + tsc clean; 8 pre-existing informational `noNonNullAssertion` warnings (unrelated test file; `check` exit 0) |
| `bunx knip` (strict, what `just ci` runs) | exit **0** — no dead code from the new exports/fields |
| `bun run test` (full suite) | **2143 pass / 1 skip / 0 fail** across 152 files (~17s). The 1 skip is the pre-existing intentional `shell-command.test.ts:51` property demo. |

New-test coverage maps to the blockers:
- **#2:** session-less projection running → `debug-disconnect` + `(detached)`; ordinary unknown-evidence running → `sync~spin` (non-regression).
- **#3:** envelope `attach.available:false` + `visibility.degraded:true` → fields ingested + drive the detached visual; absent → `null` (forward-compat).

---

## 6. Files changed (implementation commit `5ef4c4bd`)

```
src/providers/agent-status-tree-provider.ts                 (+fields, mapping, classifier, render)
test/integration/worksystem-lanes-projection.test.ts       (+2 ingestion tests)
test/tree-view/agent-status-running-detached-surface.test.ts (+10 classifier/render tests)
3 files changed, 477 insertions(+), 21 deletions(-)
```
> Provenance: the implementation was first captured by a harness auto-commit (`d80c4805`,
> generic `chore: auto-commit`, provider only). I staged my three specific paths (not
> `git add -A`, per the concurrent-lane-commit-sweep memory) and amended it into the single
> descriptive conventional commit `5ef4c4bd` (pre-commit Biome hook passed). `d80c4805`
> remains in the object store, off-branch. A concurrent recovery lane then committed the
> handoff docs on top (see §7).

---

## 7. Final git state

```
HEAD:   <this docs commit> docs(research): full implementation handoff for cc-installed-vsix-dogfood-proof
parent: 242d206b docs(research): record installed-VSIX dogfood-proof contract-failure recovery
        5ef4c4bd fix(agent-status): render detached truth for liveness-unobservable running lanes
        ff4a097e docs(research): record high-benefit bug hunt
git status --porcelain: clean (apart from the gitignored .oste-report.yaml)
```

Nothing pushed, tagged, published, or installed. No `--no-verify`.

## 8. Recommended next steps
1. **Decide the off-node skip-vs-fail policy** for `release-proof`, then wire it into `cut-preview` after `just prerelease` (§3).
2. **Live installed-VSIX dogfood pass** (authorized release lane): build → install → confirm a real `running` launcher row with `attach.available:false` renders `debug-disconnect`/`(detached)` instead of the spinner.
3. Optional follow-up: generalize the structural detached path beyond `lane_projection` to plain **daemon** primary rows that are session-less (currently scoped to projection rows for provable safety).
4. Optional: surface `attach.reason_if_unavailable` as a quick-pick hint when a user clicks a detached row (focus already "refuses loudly" on the invalid `launcher:<id>` session).
