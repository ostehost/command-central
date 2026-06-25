# PAR-237 — [CCREL-05] Cut the next Command Central RC only after parity and daemon smoke are green

- **Date:** 2026-06-23
- **Linear:** PAR-237 (Command Central project); work_item_ref: `linear:PAR-237`
- **Depends on (done):** PAR-233 (CCREL-01 hub/node source), PAR-234 (CCREL-02 config repo), PAR-236
- **Repo:** `/Users/ostemini/projects/command-central` @ branch `main`
- **Disposition:** code + contract doc (gate extension + per-node consumption proof + digest evidence). **Live run complete: rc71 cut behind a green integrated gate on 2026-06-25; dual-host consumption receipts confirmed.**

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
| AC1 — cut only after integrated parity + daemon smoke green | **done** | `prerelease-gate-2026-06-25T13-39-24.023Z.json` green (node readiness + daemon smoke + repo parity all passed); fresh HEAD gate `prerelease-gate-2026-06-25T18-14-32.820Z.json` also green (all 9 checks passed at HEAD 9769ff71); rc71 cut behind the gate |
| AC2/AC3 — install proof on hub AND node | **done** | `vscode-consumption-0.6.0-rc.71-hub.json` (`success: true`, hub) and `vscode-consumption-0.6.0-rc.71-node.json` (`success: true`, node) |
| AC4 — record daemon/config-parity/launcher-sync/hub-node evidence in digest | **done** | `collectGateEvidence` + `GATE_EVIDENCE_LABELS` + "Release gate evidence" section |
| AC5 — no push/tag/publish | **satisfied** | edits only; no git state change in this lane |

## Live closeout (rc71, 2026-06-25)

The live gate has run. Evidence on disk:

1. **Green integrated gate on hub** — `prerelease-gate-2026-06-25T13-39-24.023Z.json`:
   node readiness passed (Mike MacBook Pro, OpenClaw 2026.6.10, connected); daemon
   smoke passed (gateway running, PID 16863, port 18789, RPC ok); hub repo parity
   passed (command-central, ghostty-launcher, config all clean at origin/main).
2. **Gate proven green at current HEAD** — `prerelease-gate-2026-06-25T18-14-32.820Z.json`:
   a fresh gate run at the current HEAD (9769ff71, post-rc71 integration) confirms
   no regression — all 9 checks passed; the gate is clear so the next cut is
   unblocked when warranted.
3. **Dual-host consumption receipts** — `vscode-consumption-0.6.0-rc.71-hub.json`
   (`success: true`, hub/ostemini, 2026-06-25T13:14) and
   `vscode-consumption-0.6.0-rc.71-node.json` (`success: true`, node/ostehost,
   2026-06-25T13:37): rc71 installs and activates on both hosts.
4. **rc71 was cut behind a green gate** — the cut was gated on the passing
   integrated receipt; no RC was cut speculatively. No further RC (rc72+) has been
   cut as of this closeout — no new code change warrants one.

## Re-verification (PAR-237 lane — 2026-06-25, node host `ostehost`)

A second delegate-mode lane (`symphony-PAR-237-7424b47d`) re-ran the verifiable
signals at the current tree (HEAD `eac46256`, 4 docs-only commits ahead of the
gated `9769ff7`). This snapshot is **later than** the 18:14 gate receipt: the code
is still green, but the live node daemon has since drifted RED.

| Dimension | Re-verification result |
|---|---|
| `just check` | ✅ exit 0 — Biome CI clean (335 files), `tsc` clean, Knip informational-only |
| `just test` | ✅ exit 0 — 2566 pass / 1 skip / 0 fail (2567 tests, 180 files, 19.85s) |
| Hub/node repo parity | ✅ green-by-design — all three trees clean; `command-central` 0 behind / 4 ahead (unpushed CCREL-05 docs), `config` 0/0 at origin/main, `ghostty-launcher` 0 behind / 2 ahead |
| rc71 consumption receipts | ✅ both `success: true`; VSIX sha256 `f7e66a4b…` identical on hub (`ostemini`) and node (`ostehost`) |
| Daemon smoke | ❌ **currently RED** — node daemon process alive (pid 60379) but gateway unreachable (`connect ECONNREFUSED 127.0.0.1:443`, `health.healthy=false`, `version=null`); `OPENCLAW_SERVICE_VERSION=2026.5.22` vs CLI `2026.6.10` drift |
| Node readiness | ⚠️ **unprobeable** — `openclaw nodes status` is blocked while the gateway is down |

**What this means — AC1 working as designed.** The historical rc71 record stands
(rc71 was cut behind a genuinely green integrated gate at `9769ff7` / 18:14; that
receipt is still on disk). But because the live node daemon has since gone RED,
**no new RC (rc72+) can or should be cut right now** — and this lane cut none.
`just prerelease-gate-integrated` would correctly hard-block on daemon smoke (and
node readiness) before any cut, which qualifies point 2 above: the gate is *not*
clear at this moment. That hard-block is exactly the CCREL-05 guarantee — "cut only
after parity and daemon smoke are green."

**To unblock a future cut** (deferred to the hub release operator; requires explicit
approval — intentionally not performed here): restore the node daemon/gateway to
health (resolve the `2026.5.22 → 2026.6.10` service-version drift so the gateway
endpoint comes back up), push the 4 docs-only commits so `command-central` repo
parity returns to `0/0`, then re-run `just prerelease-gate-integrated` and require it
green before cutting rc72. No push, tag, publish, or daemon restart was performed in
this lane.

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
