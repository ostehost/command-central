# RESULT — History / dead-row inline action scoping fixup

- **task_id:** `cc-history-dead-row-action-fixup-20260614`
- **Mode:** implementation (package.json menu scoping + targeted tests)
- **Scope:** `/Users/ostehost/projects/command-central`
- **Date:** 2026-06-14
- **Commit:** `e9dfde5f8e618d1af865a4c5fd76b3725a39deb0`
- **Verdict:** ✅ **DONE.** Both confirmed P1s fixed with a minimal `package.json`-only
  `when`-clause narrowing, mirroring the existing `showAgentOutput` running-only pattern.
  Two behavioral menu-contribution tests added. Targeted tests + `just check` green.
  Tree clean. Not pushed/tagged/published.

---

## 1. What changed and why

The audit (`research/RESULT-cc-history-dead-row-action-audit-20260614.md`, findings F1/F2)
confirmed two inline hover icons were contributed to **every** `agentTask.*` row via
`when: viewItem =~ /^agentTask\./`, so they appeared as click-to-fire buttons on
completed / dead / History rows:

- **F1 (P1) `commandCentral.focusAgentTerminal`** — click on a dead row raises a
  stale/garbled/sibling Ghostty surface or pops an unexpected resume QuickPick.
- **F2 (P1) `commandCentral.captureAgentOutput`** — click on a dead row runs a blocking
  `oste-capture.sh` shell-out (10s timeout) against a dead tmux session → near-certain
  "Failed to capture output" error toast.

Fix: narrow both inline `when` clauses to `^agentTask\.running`, the exact pattern
already used by the `showAgentOutput` inline icon (`package.json:1403`). This is a pure
**removal** of dead-row buttons — no new buttons introduced, no provider code touched
(so it does not conflict with the in-flight stable-id work on
`agent-status-tree-provider.ts`).

`^agentTask\.running` still matches `agentTask.running` and `agentTask.running.linked`
while excluding every `.reviewed` / dead variant.

### Capability retained on dead rows (no common-case loss)
- View Changes via single-click (`defaultAgentAction`) **and** inline `viewAgentDiff`.
- Right-click → Resume Session…, Restart, Reveal Directory, Remove, Mark Reviewed.
- `removeAgentTask` / `markStaleAgentFailed` / `restartAgent` inline where applicable.

### Known trade-off (optional follow-up, not in scope)
Lifecycle-conflict rows (`completed*` whose process is still alive) lose the inline
**focus** icon and must use right-click → Resume Session…. If desired later, the clean
provider-side follow-up is a `.alive` `contextValue` suffix + widened `when`. Deferred to
avoid touching the provider file under active review.

---

## 2. Exact diff

### `package.json` (the only production change)

```diff
         {
           "command": "commandCentral.focusAgentTerminal",
-          "when": "viewItem =~ /^agentTask\\./",
+          "when": "viewItem =~ /^agentTask\\.running/",
           "group": "inline"
         },
         {
           "command": "commandCentral.captureAgentOutput",
-          "when": "viewItem =~ /^agentTask\\./",
+          "when": "viewItem =~ /^agentTask\\.running/",
           "group": "inline"
         },
```

### `test/package-json/agent-menu-contributions.test.ts`

Added a `DEAD_STATUSES` constant + a `viewItemRegex()` helper that extracts and compiles
the actual `viewItem =~ /…/` regex from the manifest, then two behavioral tests:

- **`inline focusAgentTerminal is scoped to running rows (no dead/History rattle)`**
- **`inline captureAgentOutput is scoped to running rows`**

Each asserts the compiled regex matches `agentTask.running` and `agentTask.running.linked`
and rejects every `agentTask.<dead>` / `.reviewed` / `.linked` variant for all seven dead
statuses (`stopped, killed, completed, completed_dirty, completed_stale, failed,
contract_failure`). These are behavioral locks (the real regex is evaluated against sample
contextValues), not substring checks.

---

## 3. Files changed

| File | Change |
|---|---|
| `package.json` | 2 inline `when` clauses narrowed `^agentTask\.` → `^agentTask\.running` |
| `test/package-json/agent-menu-contributions.test.ts` | +`DEAD_STATUSES`, +`viewItemRegex()` helper, +2 behavioral tests |

`+56 / -2` across 2 files. No provider / source changes.

---

## 4. Commands run + results

```bash
bun test test/package-json/agent-menu-contributions.test.ts
#   19 pass / 0 fail / 102 expect() calls   (17 prior + 2 new)

bun test test/tree-view/agent-status-history-native-rows.test.ts
#   5 pass / 0 fail   (History command-less rows still locked)

just check        # biome ci + tsc + knip
#   exit 0. "Found 8 warnings" — all pre-existing, in
#   src/providers/agent-status-tree-provider.ts (non-null-assertion lint),
#   verified identical on `git stash` baseline (base exit 0). No new errors.

just fix          # exit 0, no changes beyond the two edited files

git status --porcelain   # clean after commit
```

Baseline confirmation: stashed the working tree, ran `just check` → exit 0 with the same
8 warnings; popped the stash. The warnings are not introduced by this change.

---

## 5. Compliance

- ✅ `package.json`-only production change; provider file untouched.
- ✅ Targeted menu-contribution tests added in the natural home
  (`test/package-json/agent-menu-contributions.test.ts`).
- ✅ `just check` green; `just fix` clean; targeted tests green.
- ✅ Committed only the two task-owned paths (per concurrent-lane discipline); tree clean.
- ✅ Not pushed, tagged, or published. No `--no-verify`.

---

## 6. Verdict

**Both P1 inline-action leaks are fixed.** Inline `focusAgentTerminal` and
`captureAgentOutput` now appear only on running rows; dead/completed/History rows no
longer carry the noisy live-terminal click targets while retaining all read-only and
right-click capabilities. Commit `e9dfde5f`.
