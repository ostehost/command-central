# PAR-237 — [CCREL-05] Cut the next Command Central RC only after parity and daemon smoke are green

- **Date:** 2026-06-23
- **Linear:** PAR-237 (Command Central project); work_item_ref: `linear:PAR-237`
- **Depends on (done):** PAR-233 (CCREL-01 hub/node source), PAR-234 (CCREL-02 config repo), PAR-236
- **Repo:** `/Users/ostemini/projects/command-central` @ branch `main`
- **Disposition:** code + contract doc (gate extension + per-node consumption proof + digest evidence). **Live daemon/node smoke + node-side install proof require live infrastructure — see "Live-infra gap".**

## What CCREL-05 asks

Cut the next CC RC after rc.68 **only once integrated parity + daemon smoke are
green**, then **verify install on the hub AND the node** and **record daemon
smoke / config parity / launcher sync / hub-node repo parity in the release
digest**. No push/tag/publish without explicit approval.

The mechanical cut already happened (rc.69, rc.70 shipped 2026-06-21). What was
missing — and what this change supplies — is the **integrated acceptance
evidence** wiring: the gate previously covered only repo validation + the
launcher contract (no daemon/node/parity signals), there was no rc.69/rc.70
extension-consumption proof and none for the node, and the rc digests were
generic changelogs with no parity/daemon/hub-node evidence.

## Baseline this builds on

| Component | Pre-CCREL-05 baseline | File |
|---|---|---|
| Prerelease gate | CC validation (`just ci`) + launcher validation (`just check`) + 3× launcher CLI sanity + cross-repo launcher contract; **opt-in** node readiness already present (`--require-node-readiness`) | `scripts-v2/prerelease-gate.ts` |
| Node readiness | `runNodeReadinessCheck` drives `openclaw nodes status --json` through `~/projects/config/openclaw/scripts/openclaw-node-readiness-gate.mjs` (roster-driven, strict) | `scripts-v2/prerelease-gate.ts` |
| Install proof | `verifyConsumption` writes a single receipt; older receipts already used a `-<node>` suffix (`vscode-consumption-0.6.0-rc.25-hub.json`, `…-rc.45-node.json`) but the script never produced that name itself | `scripts-v2/verify-vscode-extension-consumption.ts` |
| Release digest | Changelog section + git-derived "Since previous prerelease cut"; **no gate evidence** | `scripts-v2/release-digest.ts` |
| Gate artifact | `research/prerelease-gate/latest.json` (+ dated copy) written on every run | gate `writeReport` |

## The integrated-parity dimensions (decisions)

CCREL-05 names four evidence dimensions. Each is now a concrete, structured gate
signal and/or digest line.

### 1. Daemon smoke — `openclaw daemon smoke`

- **Probe:** `openclaw daemon status --json` (cwd = command-central repo).
- **Pure evaluation:** `evaluateDaemonSmoke(statusOutput)` — the daemon must report
  a running state (`running`/`alive`/`ok` truthy, or `state === "running"`) **and**
  a live endpoint (a non-empty `socket`/`socketPath` string **or** a finite
  numeric `pid`). Non-JSON / non-object output is an issue, not a crash.
- **Gate flag:** `--require-daemon-smoke`. Failure throws a `GateError` before any
  RC is cut, so a dead daemon hard-blocks the cut.
- **Why a live endpoint matters:** the hub dispatches to the compute node over the
  daemon socket during the release window; a daemon with no socket/pid cannot
  drive the node-side install proof.

### 2. Node readiness — `openclaw node readiness` (already present, now part of the integrated recipe)

- Hub sees the required compute node(s) **connected** and at the **expected
  OpenClaw version**, exposing the required commands. Pre-existing
  `runNodeReadinessCheck`; CCREL-05 promotes it from an isolated opt-in into the
  default integrated-gate recipe (`just prerelease-gate-integrated`).

### 3. Hub/node repo parity (incl. config parity) — `hub-node repo parity`

- **Repos checked:** `command-central`, `ghostty-launcher`, **and `config`**
  (`~/projects/config`, overridable via `--config-repo`).
- **Pure evaluation:** `evaluateRepoParity({repo, porcelain, aheadBehind})` — a repo
  is RC-ready only when its tree is **clean** (`git status --porcelain` empty) and
  it is **exactly at `origin/main`** (`git rev-list --left-right --count
  origin/main...HEAD` → `0  0`). Hub and node both sync the same `origin/main`,
  so 0/0 against origin proves the two source lines are identical — this is the
  operational restatement of the CCREL-01 (PAR-233) and CCREL-02 (PAR-234)
  closeouts, which reconciled both repos to a single `origin/main` source of
  truth on 2026-06-18.
- **Gate flag:** `--require-repo-parity`.

### 4. Launcher sync / launcher contract — `cross-repo launcher contract`

- Already enforced by the base gate (launcher `--help` flag surface, TerminalManager
  `--send`/`--command` delegation, helper-script anchoring, 3× launcher CLI
  sanity). CCREL-05 surfaces it as a named digest line so "launcher sync" is
  visible in the partnership digest, not just in the JSON artifact. The
  `just cut-preview` flow runs `just sync-launcher` immediately before the gate,
  so a green launcher contract = launcher resources synced from the canonical repo.

## Per-RC, per-node consumption proof (AC2/AC3)

`verify-vscode-extension-consumption.ts` now supports:

- `--node-label <label>` — recorded in the receipt (`nodeLabel`) so a hub receipt
  and a node receipt for the same RC are distinguishable.
- `--receipt-dir <dir>` — auto-writes `vscode-consumption-<version>[-<label>].json`
  via the exported `receiptFileName(version, nodeLabel)` (reuses the existing
  `-hub`/`-node` naming convention already on disk).

Operational shape for the next RC (run once per host):

```bash
# Hub
just verify-vscode-consumption -- \
  --vsix releases/command-central-0.6.0-rc.71.vsix \
  --expected-version 0.6.0-rc.71 \
  --node-label hub --receipt-dir research/prerelease-gate
# Node (over openclaw remote exec, same VSIX)
just verify-vscode-consumption -- \
  --vsix releases/command-central-0.6.0-rc.71.vsix \
  --expected-version 0.6.0-rc.71 \
  --node-label node --receipt-dir research/prerelease-gate
```

Result: `vscode-consumption-0.6.0-rc.71-hub.json` and
`vscode-consumption-0.6.0-rc.71-node.json` — the dual-host proof CCREL-05 requires.

## Release-digest evidence (AC4)

`release-digest.ts` now reads `research/prerelease-gate/latest.json` via
`collectGateEvidence(repoRoot)` (best-effort, mirrors `collectSinceSection`:
missing/malformed artifact ⇒ section omitted, never a hard failure) and projects
it down to the CCREL-05 evidence checks via `GATE_EVIDENCE_LABELS`:

| Gate check name | Digest label |
|---|---|
| `openclaw daemon smoke` | Daemon smoke |
| `openclaw node readiness` | Node readiness |
| `hub-node repo parity` | Hub/node repo parity |
| `cross-repo launcher contract` | Launcher contract / sync |

A **Release gate evidence** section is appended to all three formats (Discord,
markdown, plain) with a `✅/❌/⏭️` status per dimension. Base-validation checks
(CC validation, launcher CLI sanity) are intentionally excluded — they are gate
plumbing, not the integrated-parity signals. `post-release-digest.sh` carries the
section automatically (it just calls `release-digest.ts --format discord`).

## Recipe wiring (justfile)

- `just prerelease-gate` — unchanged base gate (pass-through args).
- `just prerelease-gate-integrated` — **new**; runs the base gate plus
  `--require-node-readiness --require-daemon-smoke --require-repo-parity`. This is
  the CCREL-05 gate: the next RC is cut only after this is green. Hub-only
  (requires a live OpenClaw daemon + paired compute node).

The flags are opt-in so the existing `just cut-preview` / CI-side `just
prerelease-gate` (which run where no daemon/node exists, e.g. GitHub Actions) keep
passing; the integrated gate is the hub release operator's entrypoint.

## Acceptance-criteria status

| AC | Status | Evidence |
|---|---|---|
| AC1 — cut only after integrated parity + daemon smoke green | **code complete; live run pending** | `prerelease-gate-integrated` recipe + `--require-daemon-smoke`/`--require-repo-parity`/`--require-node-readiness` |
| AC2/AC3 — install proof on hub AND node | **code complete; live run pending** | `--node-label` + `--receipt-dir` + `receiptFileName` |
| AC4 — record daemon/config-parity/launcher-sync/hub-node evidence in digest | **done** | `collectGateEvidence` + `GATE_EVIDENCE_LABELS` + "Release gate evidence" section |
| AC5 — no push/tag/publish | **satisfied** | edits only; no git state change in this lane |

## Live-infra gap (why this is `partial`)

The following cannot be produced in this edit-only environment — they need the
hub with a live OpenClaw daemon and a paired, connected compute node:

1. **A green `just prerelease-gate-integrated` run** at the next RC HEAD
   (the daemon-smoke + node-readiness checks call the live `openclaw` binary).
2. **The dual-host consumption receipts** `vscode-consumption-0.6.0-rc.<N>-hub.json`
   and `…-node.json` (require the RC VSIX installed and `code` on both hosts).
3. **The cut itself** of the next RC (rc.71) — gated on (1).

The code, scaffolding, recipe, and digest wiring for all three are in place; only
the live execution on hub+node remains.

## Constraints honored

- Edits confined to the allowed file-set: `justfile`,
  `scripts-v2/{prerelease-gate.ts,verify-vscode-extension-consumption.ts,release-digest.ts,post-release-digest.sh}`,
  and this `research/` doc.
- ESM with `.js`-less local imports preserved (these scripts import node builtins
  and sibling `.ts` only where existing code does); strict TS, zero `as any`.
- New gate fields are optional on `GateConfig` so existing callers/tests still
  type-check; new pure helpers are exported following the file's existing
  `runNodeReadinessCheck` / `collectSinceSection` export convention.
- No push, tag, publish, or `--no-verify`.
</content>
</invoke>
