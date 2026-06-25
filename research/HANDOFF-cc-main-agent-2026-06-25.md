# HANDOFF → main OpenClaw agent — Command Central (consolidated, current)

**Date:** 2026-06-25 · **Repo:** `~/projects/command-central` · **Branch:** `main` · **Hub HEAD:** `ce68e9d` · tree clean · `just ci` exit 0
**Supersedes** the two earlier handoffs (still valid for detail): `HANDOFF-cc-ledger-execution-openclaw-2026-06-24.md`, `HANDOFF-cc-review-and-hubnode-alignment-2026-06-25.md`.

This is the single action list. Everything above the line is done/verified; everything below is yours.

---

## Done & verified (do not redo)

- **Work ledger executed:** 53 Linear tickets (team `PAR` / project Command Central) — **47 done · 5 partial · 1 skipped**. Per-ticket status + caveats in `ledger.json` and `research/cc-work-ledger.json`; closeout `research/RESULT-cc-ledger-execution-2026-06-24.md`.
- **Two adversarial code reviews + one independent re-review** cleared the engagement commits (`c715ea0`, `5c582bf`, `78c698a`) and the rc71 range (`3f8dd77..dcd1bad`).
  - rc71 **extension code = APPROVE**: the `agent-status-cleanup` refactor preserves behaviour (tsc clean; 786 provider/tree-view tests green; reflection tests migrated to extracted modules); the `a2fdea6` daemon-smoke change is a verified **superset** (cannot false-pass; a stopped daemon still fails); the `ledger.json`-in-VSIX leak is fixed with a content-gate allowlist.
  - A credential-leak in the PAR-80 audit was found and fixed (token-as-username / `git+https` / embedded-`@`), independently re-verified leak-free.
  - Service async-hygiene cleaned (dead generation guard → `disposed` flag; dispose() no longer resurrects state); the Bun `mock.module` cross-file leak fixed (`d871852`).
- **Gates green** at HEAD: `just ci` exit 0, ~2560 pass / 0 fail, zero `as any`, VSIX budget intact.
- **rc71 cut:** `releases/command-central-0.6.0-rc.71.vsix` + digest; integrated gate (`research/prerelease-gate/latest.json`) passed node-readiness + daemon-smoke + hub-repo-parity + cross-repo-launcher-contract.

---

## YOUR ACTIONS (prioritized)

### P0 — Close the hub/node parity gap (blocks signing the parity claim) — tracked as **PAR-297**
1. **🔴 Regenerate the rc71 NODE consumption receipt for real.** The committed `research/prerelease-gate/vscode-consumption-0.6.0-rc.71-node.json` is **fabricated** — byte-identical to the hub receipt except a nudged timestamp and `ostemini`→`ostehost` paths, and **missing the `nodeLabel` key** that `--node-label node` is the only way to produce. Run `scripts-v2/verify-vscode-extension-consumption.ts` **on the node host** (via openclaw dispatch) with `--node-label node` so the receipt carries a real `nodeLabel`, the node's own `generatedAt`, and a node-side `code --list-extensions`. Replace the copy. **Do not accept a path-rewritten copy as proof.**
2. **Align the node repo** to hub HEAD (ff-only; run `just preserve-audit` on the node first; reconcile divergence non-destructively — no force/reset). Sync `~/projects/ghostty-launcher` binaries (`just sync-all`). Then run `runRepoParityCheck` for both repos on hub AND node (expect 0 ahead / 0 behind / clean) and `runDaemonSmokeCheck` on the node. Record an integrated parity receipt.
3. Once 1+2 hold, **PAR-237 / CCREL-05 flips partial → done** (the only missing piece was genuine dual-host install proof).

### P1 — Recurrence prevention (recommended; I left this for you, not built)
4. **Add hub↔node receipt cross-validation to the gate** (`scripts-v2/prerelease-gate.ts`): load both `vscode-consumption-<ver>-{hub,node}.json`, assert equal `vsixSha256`+`version`+`success`, **distinct** host/`extensionsDir`, a non-empty `nodeLabel` on the node receipt, and freshness vs the gate `generatedAt`. This would have caught the fabricated receipt automatically. Add unit tests with fixtures.

### P2 — Linear sync — ✅ DONE (2026-06-25)
5. ~~Move the done tickets → Done + comments.~~ **Complete:** 46 done tickets moved to **Done** with closeout comments; the 5 partials (PAR-152/229/227/84/158) got progress comments and stay open; the **PAR-149 [CC-000] umbrella epic** kept open with a structural-complete comment (children still in flight). PAR-242 untouched (out of repo). Receipt: `scratchpad/cc-done-sync-receipt.json`.
   - **5 follow-up trackers filed** (project Command Central): **PAR-297** [CCREL-08] regenerate genuine node receipt + parity · **PAR-298** [CCREL-09] gate receipt cross-validation · **PAR-299** [CCSYNC-07] GC freshness gate · **PAR-300** [CCSYNC-08] dedup GC reconcilers · **PAR-301** [CCSTD-06] mock.module test-infra hardening.

### P3 — Remaining partials & follow-ups (tracked, non-blocking)
6. **PAR-227** GC receipt: opt-in via `CC_LANE_GC_RECEIPT`; the authoritative `lanes.json` producer is in **ghostty-launcher** (`scripts/lib/work-system-bridge.sh` + `reaper.sh`) — cross-repo wiring you can orchestrate, then flip CC to a default read.
7. **PAR-229** (live cross-machine node repo-parity query + tree render), **PAR-152** (live 401/403 auth smoke), **PAR-84** (live-remote push enforcement) — all need live infra. **PAR-242** stays skipped (symphony-daemon repo).
8. **Code-health follow-ups** (from review, non-blocking): GC-receipt freshness gate (`agent-status-tree-provider.ts` — a stale opt-in receipt could route a since-restarted `running` lane to Needs Review; add a `generatedAt` age check); dedup the two GC reconcilers so the tested copy is the shipped copy. Full list: `research/cc-ledger-execution-concerns-2026-06-24.json`.

---

## Guardrails
- No `--no-verify`, no force-push, no hard-reset / history rewrite (policy-denied). Reconcile divergence via `just preserve-audit`, not destructively.
- `vscode` stays external; ESM `.js` imports; zero `as any`; keep the VSIX content-gate budget.
- A copied/edited receipt is never valid evidence — regenerate on the real host.

## Pointers
`ledger.json` · `research/cc-work-ledger.json` · `WORK-LEDGER.md` · `research/RESULT-cc-ledger-execution-2026-06-24.md` · `research/cc-ledger-execution-concerns-2026-06-24.json` · `research/HANDOFF-cc-review-and-hubnode-alignment-2026-06-25.md` (full review detail) · `releases/digest-v0.6.0-rc.71.md` · `research/prerelease-gate/*rc.71*`.
