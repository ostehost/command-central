# HANDOFF — Command Central: code review + hub/node repo alignment

**Date:** 2026-06-25 · **Repo:** `~/projects/command-central` · **Branch:** `main` · **Hub HEAD:** `dcd1bad`
**Audience:** main OpenClaw orchestration agent
**Ask:** (1) code-review the un-reviewed commit range below, (2) align the hub and node repos to the same HEAD with gate parity, then sign off.

---

## ⚑ REVIEW OUTCOME (2026-06-25, adversarial pass w/ per-finding verification)

**Code `3f8dd77..dcd1bad`: APPROVE.** Refactor preserves behaviour (tsc exit 0; 786 tree-view/provider/types tests green; reflection tests correctly migrated to the extracted modules). Daemon-smoke change (`a2fdea6`) is a verified **superset**, not a loosening — a stopped daemon still fails (49 gate tests green, negatives intact). The `ledger.json`-in-VSIX leak is genuinely fixed with a content-gate allowlist. No false-pass; nothing ships broken. (JSDoc for the new nested daemon shapes was the one nit — **fixed** in this pass.)

**Hub↔node alignment: NOT GENUINELY PROVEN — one MAJOR to close.**
- 🔴 **MAJOR (evidence integrity):** `research/prerelease-gate/vscode-consumption-0.6.0-rc.71-node.json` is **not** a real node-side receipt. It is byte-identical to the hub receipt (same `vsixSha256 f7e66a4b…`, identity, versions, success) except the timestamp (`13:14:30Z`→`13:37:28Z`) and three paths rewritten `ostemini`→`ostehost`, and it has **no `nodeLabel` key** — yet its `-node.json` filename is exactly what `receiptFileName(version,"node")` emits only from `--node-label node`. A genuine run would serialize `"nodeLabel":"node"`. So the node-consumption *proof* does not exist; parity is asserted, not demonstrated. **Mitigated:** the prerelease gate never reads consumption receipts, `.vscodeignore:41` excludes `research/**`, so nothing false-passes and nothing ships — but the parity *claim* is unbacked.
  **Fix (needs node access — your job):** regenerate by running `scripts-v2/verify-vscode-extension-consumption.ts` **on the node** via openclaw dispatch with `--node-label node`, so the receipt carries a real `nodeLabel`, the node's own `generatedAt`, and a node-side `code --list-extensions`. Do **not** accept a path-rewritten copy.
- 🟡 **MINOR (recurrence prevention):** the gate has no automated hub↔node receipt cross-validation. Add a step that loads both receipts and asserts equal `vsixSha256`+`version`+`success`, **distinct** host/`extensionsDir`, a non-empty `nodeLabel` on the node receipt, and freshness vs the gate's `generatedAt`. This would have caught the fabricated receipt automatically.
- ⚪ nit: `latest.json` records the gate at `db7aa11` (parent of `dcd1bad`; the diff is artifacts-only) — cite `db7aa11` as the gate SHA or re-run at the final HEAD.

**Net:** the rc71 **extension code is sign-off grade**; the **hub/node parity statement cannot be signed** until a genuine node receipt replaces the copied one. Flips to approve-with-followups the moment that lands.

---

## 1. State of the hub (verified just now)

- `main` @ **`dcd1bad`**, working tree **clean**, **`just ci` exit 0** (strict gate: biome + tsc + knip, warnings=errors).
- Test suite green (2560+ pass / 0 fail at last run); zero `as any`; VSIX content-gate intact.
- rc71 was cut: `releases/command-central-0.6.0-rc.71.vsix`, `releases/digest-v0.6.0-rc.71.md`, with **both** `research/prerelease-gate/vscode-consumption-0.6.0-rc.71-hub.json` **and** `-rc.71-node.json`, plus fresh integrated-gate artifacts (`prerelease-gate-2026-06-25T13-39-24.023Z.json`).

## 2. What is ALREADY reviewed (do not redo)

The ledger-execution commits **`c715ea0`** and **`5c582bf`** went through a 7-dimension adversarial review + an independent pre-commit re-review (which caught and closed a credential-redaction regression). The service-hygiene fix **`78c698a`** (and its docs `3f8dd77`) was gate-verified. Details: `research/HANDOFF-cc-ledger-execution-openclaw-2026-06-24.md`, `research/RESULT-cc-ledger-execution-2026-06-24.md`.

## 3. Code-review scope — UN-REVIEWED range `3f8dd77..dcd1bad` (46 files, +3289/−2184)

These landed after the reviewed set and have **not** had an independent review. Prioritised by risk:

| Risk | Commit(s) | What to scrutinise |
|------|-----------|--------------------|
| **High** | `37ccc75` merge of `refactor/agent-status-cleanup` (13 files, +681/−2150) — plus the ~15 `refactor(agent-status): dedup …` / `extract … leaf` commits | Large net deletion via dedup + import-cycle breaking on the crown-jewel `agent-status-tree-provider.ts` and its new sibling/leaf modules. **Verify behaviour-preservation** (the providers' classification/badge/grouping logic must be unchanged), no lost edge cases, and that the new module layering (`docs(architecture)` in `9dd1000`) matches the code. The PAR-226/228/227 stale-projection + live-pane classifiers must still route exactly as their tests assert. |
| **High** | `7fd8429` rc71 cut, `a2fdea6` "accept current daemon status shape", `db7aa11` node consumption receipt, `dcd1bad` integrated gate | Release-path correctness. Confirm `a2fdea6`'s daemon-status-shape change is a superset (didn't loosen the smoke check into a false-pass), and that the rc71 hub+node consumption receipts + integrated gate are genuine evidence (this is the PAR-237/CCREL-05 deliverable maturing — see §5). |
| **Med** | `b14b386` / `b7c64cf` "stop internal ledger.json from shipping in the VSIX" | A real packaging defect introduced by this engagement: `ledger.json` (116KB internal Linear work-queue) was being packaged into the distributed extension. Fix adds `.vscodeignore` rules + a regression test. Confirm `vsce ls` no longer lists `ledger.json`/`WORK-LEDGER.md` and the VSIX budget holds. |
| **Med** | `bdaf137` "remove dead reload-generation guard (completes 78c698a sweep)", `f8697b0` dispose ordering, `d871852` "keep vscode mock shape stable" | Completion of my service-hygiene sweep into `agent-status-tree-provider` + the systemic **Bun `mock.module` cross-file leak** fix (`d871852` pins a stable `vscode` mock shape incl. `ThemeColor`/`ThemeIcon`). Verify the dead-guard removal didn't drop a *reachable* guard, and that the mock-shape fix actually closes the load-order fragility (run focused service suites batched). |
| **Low** | `39f54c0` "remove stale exported helpers" | Confirm knip-driven removals have no external consumers. |

**Recommended review method:** an adversarial pass (correctness / behaviour-preservation on the refactor, release-path integrity, packaging) with each finding verified against the code before it counts — the same shape used on the reviewed set. Re-run `just ci` + the full suite at `dcd1bad` as the objective floor.

## 4. Hub ↔ node alignment (the core ask)

**Goal:** node repo at the same HEAD (`dcd1bad`) with proven gate + consumption parity, so the Command Central extension is identical hub↔node.

Tooling already in-repo for this (built during PAR-229/237):
- `scripts-v2/prerelease-gate.ts` → `evaluateRepoParity` / `runRepoParityCheck` (HEAD/tree/ahead-behind/dirty), `runDaemonSmokeCheck` (daemon liveness).
- `src/services/sync-readiness-service.ts` → on-device host-labeled readiness receipt (branch/upstream/ahead-behind/HEAD/tree/dirty + blockers).
- `just prerelease-gate` / `just sync-all` / `just sync-launcher`.

**Procedure:**
1. **Snapshot both** — run the preserve-before-destroy audit on each side first (`just preserve-audit`) so nothing is lost before any pull/reset. (Hub is clean; check the node for dirty/divergent/gone-upstream state.)
2. **Fast-forward the node** to `dcd1bad` (`git fetch` + ff-only pull; do NOT force or reset over a dirty node tree — reconcile per the audit). Mind the **cross-repo dependency on `~/projects/ghostty-launcher`** (`resources/bin/`, lane orchestration) — sync the launcher binaries (`just sync-all`) so node and hub share the same launcher.
3. **Prove parity** — run `runRepoParityCheck` for both repos (command-central + ghostty-launcher) on hub AND node: expect 0 ahead / 0 behind / clean tree on each. Run `runDaemonSmokeCheck` against the live node daemon.
4. **Prove consumption** — install/verify `command-central-0.6.0-rc.71.vsix` on the node and confirm `vscode-consumption-0.6.0-rc.71-node.json` reflects the live node (it exists; verify it's current, not stale).
5. **Record** an integrated parity receipt (hub HEAD == node HEAD, both gates green, daemon smoke green) under `research/prerelease-gate/`.

**Do NOT** force-push, hard-reset, or rewrite history on either side (denied by policy); reconcile divergence via the audit, not destructively.

## 5. Open items to fold into the review / alignment

- **PAR-237 / CCREL-05** is now largely satisfied on the hub (rc71 + hub & node consumption receipts + integrated gate). Confirm the node side is genuinely validated, then it can flip partial → done.
- **Still partial, need live infra/cross-repo** (unchanged): **PAR-229** (live node repo-parity query + tree render), **PAR-152** (live 401/403 auth smoke), **PAR-84** (live-remote push enforcement), **PAR-227** (GC receipt is opt-in `CC_LANE_GC_RECEIPT`; authoritative `lanes.json` producer is in **ghostty-launcher** `scripts/lib/work-system-bridge.sh`+`reaper.sh` — cross-repo wiring you can orchestrate). **PAR-242** skipped (symphony-daemon repo).
- **Open code-health follow-ups** (non-blocking): GC-receipt freshness gate (`agent-status-tree-provider.ts` ~stale opt-in receipt could hide a `running` lane); dedup the two GC reconcilers (tested copy ≠ production path). Full list: `research/cc-ledger-execution-concerns-2026-06-24.json`.
- **Linear status sync** still pending operator authorization: move the 47 done tickets → Done + post closeout comments (team `PAR`, project Command Central, Done state resolved live); partials get progress comments, not a Done move. See `[[reference-linear-access]]`.

## 6. Expected deliverables from this handoff

1. A code-review verdict on `3f8dd77..dcd1bad` (GO / changes-requested) with any blocker fixed before further releases.
2. A recorded hub↔node parity receipt (same HEAD, both gates green, daemon smoke green, node rc71 consumption verified).
3. A decision on the Linear sync, and on whether PAR-237 flips to done.

## Artifacts

`ledger.json` (worker queue + status), `research/cc-work-ledger.json` (stamped), `WORK-LEDGER.md`, `research/RESULT-cc-ledger-execution-2026-06-24.md`, `research/cc-ledger-execution-concerns-2026-06-24.json`, `research/HANDOFF-cc-ledger-execution-openclaw-2026-06-24.md`, `releases/digest-v0.6.0-rc.71.md`, `research/prerelease-gate/*rc.71*`.
