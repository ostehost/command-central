# RESULT — History / completed / dead row action audit

- **task_id:** `cc-history-dead-row-action-audit-20260614`
- **Mode:** read-only UX/action audit (working tree left untouched — see §8)
- **Scope:** `/Users/ostehost/projects/command-central`
- **Date:** 2026-06-14
- **Reviewer verdict:** **2 confirmed P1 findings.** Two *inline hover* actions —
  `commandCentral.focusAgentTerminal` and `commandCentral.captureAgentOutput` — are
  contributed to **every** `agentTask.*` row regardless of status, so they appear as
  click-to-fire icon buttons on completed / dead / History rows and produce
  live-terminal side effects (raise a stale Ghostty surface, pop a resume QuickPick,
  or run a 10s blocking `oste-capture.sh` shell-out that ends in an error toast). No
  P0. The right-click context menu and the single-click default action are already
  correctly scoped — no change needed there.

This confirms the UX lane's P1 risk flag verbatim: inline `focusAgentTerminal` /
`captureAgentOutput` *do* appear on dead/completed History rows and *do* make noise
when clicked.

---

## 1. Method

Cross-referenced three surfaces that can dispatch a command from a tree row:

1. **`package.json` → `contributes.menus["view/item/context"]`** (lines 1285–1496) —
   inline hover icons (`"group": "inline"`) and right-click menu groups.
2. **Provider `contextValue` assignment** — `src/providers/agent-status-tree-provider.ts:9347-9350`
   sets `agentTask.${task.status}` (+ optional `.reviewed` / `.linked` suffixes).
3. **Single-click `item.command`** — `agent-status-tree-provider.ts:9353-9357`
   (`defaultAgentAction`) and its handler `register-agent-navigation-commands.ts:96-129`.

Status enum (`agent-status-tree-provider.ts:176-185`): `running` is the only live
status; **`stopped, killed, completed, completed_dirty, completed_stale, failed,
contract_failure`** are all terminal/"dead" rows. Section routing
(`getNodeStatusGroup`, line 4458) sorts these terminal rows across **History (done)**,
**Needs Review (limbo)**, and **Action Required (attention)** — but the menu `when`
clauses key on *status* (`contextValue`), not section, so the audit applies to every
dead row in all three sections.

---

## 2. Inventory — actions on a dead/History row

Representative row `agentTask.completed` (clean completed → History/done). `⚠️` = noisy
live-terminal action on a finished task; `✓` = appropriate for a dead row.

### Inline hover icons (fire on a single click, no confirmation)

| Action | `when` (package.json) | On dead row? | Behavior when clicked on a dead row |
|---|---|---|---|
| `focusAgentTerminal` | `viewItem =~ /^agentTask\./` (L1383) | **YES ⚠️** | Non-running + has session/bundle → tries to raise the launcher Ghostty bundle (may surface a **stale/garbled/sibling** window or `open -a` a fresh empty bundle); non-running + no surface → routes to `resumeAgentSession` which **pops a resume QuickPick**. See `extension.ts:1033-1046`. |
| `captureAgentOutput` | `viewItem =~ /^agentTask\./` (L1388) | **YES ⚠️** | `execFileSync("bash", [oste-capture.sh, session_id], {timeout:10000})` against a dead tmux session → **blocking shell-out then "Failed to capture output" error toast** (or stale buffer text). See `register-agent-registry-commands.ts:108-156`. |
| `viewAgentDiff` | `viewItem =~ /^agentTask\./` (L1418) | YES ✓ | Read-only diff view. Appropriate. |
| `removeAgentTask` | `…(failed\|stopped\|killed\|completed\|completed_dirty\|completed_stale\|contract_failure)` (L1408) | YES ✓ | History management. Appropriate. |
| `markStaleAgentFailed` | `viewItem == agentTask.completed_stale` (L1413) | stale only ✓ | Appropriate (stale rows). |
| `restartAgent` | `…agentTask\.failed/ && hasLauncher` (L1423) | failed only ✓ | Appropriate. |
| `killAgent` | running / discoveredAgent.running only (L1393) | no ✓ | Correctly excluded from dead rows. |
| `showAgentOutput` | `…/^agentTask\.running/ \|\| discoveredAgent.running` (L1403) | no ✓ | **Already the exact pattern the two ⚠️ entries should mirror.** |

### Right-click context menu (intentional, multi-step) — all correctly scoped

| Action | `when` | Notes |
|---|---|---|
| `viewAgentDiff` | `^agentTask\./` (navigation, L1429) | ✓ read-only |
| `openAgentDirectory` | `^agentTask\./` (navigation, L1449) | ✓ reveal dir |
| `restartAgent` | `…(completed\|completed_dirty\|failed\|stopped)/ && hasLauncher` (L1454) | ✓ |
| `resumeAgentSession` | `…(completed\|completed_dirty\|stopped\|failed\|completed_stale\|contract_failure)/` (L1459) | ✓ intentional resume path |
| `removeAgentTask` | dead statuses (L1464) | ✓ |
| `markAgentReviewed` | dead statuses & not `.reviewed` (L1469) | ✓ |

`focusAgentTerminal` and `captureAgentOutput` are contributed **only** to the `inline`
group — they have no right-click entry — so the fix is purely about the inline icons.

### Single-click default action — already safe

`defaultAgentAction` (`agent-status-tree-provider.ts:9353`) routes `running → focusAgentTerminal`
and **`non-running → viewAgentDiff` ("View Changes")** (`register-agent-navigation-commands.ts:114-128`).
The dense History group/time/overflow rows carry no command at all
(locked by `test/tree-view/agent-status-history-native-rows.test.ts`, commit `ad77b30`).
So the *only* unguarded noisy surface left on a dead row is the two inline hover icons.

---

## 3. Findings

### F1 — P1: `focusAgentTerminal` inline icon on every non-running row
- **Where:** `package.json:1381-1385` (`"group": "inline"`, `when: viewItem =~ /^agentTask\./`).
- **Why it's a bug:** the regex matches all dead variants (`agentTask.completed`,
  `…completed_dirty`, `…completed_stale`, `…failed`, `…contract_failure`, `…stopped`,
  `…killed`, plus `.reviewed`/`.linked` suffixes). On a finished row a single accidental
  click on the focus icon either raises a stale/garbled/sibling Ghostty surface (the
  bundle-trust gate at `extension.ts:1059-1117` *suppresses* lying strategies but the
  net user-visible effect is still a window raise / fresh-attach warning) or pops an
  unexpected resume QuickPick (`extension.ts:1040-1046` → `resumeAgentSession`).
- **Severity rationale — P1 not P0:** no data loss, fully recoverable, and the
  most-common accidental interaction (full-row single click) is already safe. But it
  is a repeatable, surprising live-terminal side effect on a row whose work is done,
  and it scales with History density (N dead rows = N stray focus buttons). Exactly the
  rattle/noise the UX lane flagged.

### F2 — P1: `captureAgentOutput` inline icon on every non-running row
- **Where:** `package.json:1386-1390` (`"group": "inline"`, `when: viewItem =~ /^agentTask\./`).
- **Why it's a bug:** dead History rows almost always still carry `session_id`, so the
  guard at `register-agent-registry-commands.ts:111-117` passes and the handler runs a
  **blocking `execFileSync` (10s timeout)** of `oste-capture.sh` against a dead tmux
  session → near-certain failure → `"Failed to capture output: …"` error toast (or
  stale buffer dump). Pure noise on a completed task; no useful result is possible once
  the session is gone.
- **Severity:** P1 (lower end — toast + transient block, no state change). Bundle it
  with F1 since the fix is identical.

### Not findings (verified clean)
- Right-click context menu actions (§2) — all status-scoped correctly.
- Single-click `defaultAgentAction` — already routes dead rows to read-only View Changes.
- `killAgent` / `showAgentOutput` inline — already running-gated.
- History group/time/overflow/state rows — already command-less (`ad77b30`).

---

## 4. Recommended fix (exact, minimal, non-conflicting)

**Scope both noisy inline entries to running rows, mirroring `showAgentOutput`'s
existing pattern.** This is a **`package.json`-only** change — it does **not** touch
`agent-status-tree-provider.ts` (the file under active review), so it cannot conflict
with the stable-id work.

### Edit 1 — `package.json` ~L1381-1385
```jsonc
// BEFORE
{
  "command": "commandCentral.focusAgentTerminal",
  "when": "viewItem =~ /^agentTask\\./",
  "group": "inline"
}
// AFTER
{
  "command": "commandCentral.focusAgentTerminal",
  "when": "viewItem =~ /^agentTask\\.running/",
  "group": "inline"
}
```

### Edit 2 — `package.json` ~L1386-1390
```jsonc
// BEFORE
{
  "command": "commandCentral.captureAgentOutput",
  "when": "viewItem =~ /^agentTask\\./",
  "group": "inline"
}
// AFTER
{
  "command": "commandCentral.captureAgentOutput",
  "when": "viewItem =~ /^agentTask\\.running/",
  "group": "inline"
}
```

Why `^agentTask\.running` (and not `… || discoveredAgent.running`): this is a pure
*removal* of dead-row buttons with zero new buttons introduced — `discoveredAgent.*`
rows never carried these inline icons and already focus via the single-click default
action; `captureAgentOutput`'s handler only reads `node.task.session_id` and would just
warn on a discovered row anyway. Keeping the change to a one-token narrowing keeps the
blast radius minimal. `^agentTask\.running` still correctly matches `agentTask.running`
and `agentTask.running.linked` while excluding every `.reviewed`/dead variant.

### What dead rows retain (no capability lost for the common case)
- View Changes via single-click and inline `viewAgentDiff`.
- Right-click → Resume Session…, Restart, Reveal Directory, Remove, Mark Reviewed.
- `removeAgentTask` / `markStaleAgentFailed` / `restartAgent` inline where applicable.

### Known trade-off / optional follow-up
The one legitimate "focus a non-running row" case is a **lifecycle-conflict** task
(`completed*` whose process is still alive — `classifyLifecycleConflict`,
`agent-task-classification.ts:384`, surfaced in Action Required). After this fix those
rows lose the inline focus icon and must use right-click → Resume Session…. If the team
wants to preserve inline focus there, the clean follow-up (provider-side, defer until
the stable-id review lands to avoid conflict) is to append a `.alive` suffix to the
`contextValue` for live-process-conflict rows and widen the `when` to
`viewItem =~ /^agentTask\.running/ || viewItem =~ /^agentTask\..*\.alive/`. Not required
for the P1 fix.

---

## 5. Tests to add

Add to `test/package-json/agent-menu-contributions.test.ts` (it already parses
`view/item/context` and asserts inline scoping for `restartAgent`/`openFileDiff`, so
this is the natural home). The helper evaluates the actual `viewItem` regex against
sample contextValues — a behavioral lock, not a substring check.

```ts
const DEAD_STATUSES = [
  "stopped", "killed", "completed", "completed_dirty",
  "completed_stale", "failed", "contract_failure",
] as const;

function viewItemRegex(when: string | undefined): RegExp {
  const m = when?.match(/viewItem =~ \/(.+?)\//);
  if (!m) throw new Error(`not a viewItem regex when-clause: ${when}`);
  return new RegExp(m[1]);
}

test("inline focusAgentTerminal is scoped to running rows (no dead/History rattle)", async () => {
  const menu = await getViewItemContextMenu();
  const inline = menu.find(
    (i) => i.command === "commandCentral.focusAgentTerminal" && i.group === "inline",
  );
  expect(inline).toBeDefined();
  const re = viewItemRegex(inline?.when);
  expect(re.test("agentTask.running")).toBe(true);
  expect(re.test("agentTask.running.linked")).toBe(true);
  for (const s of DEAD_STATUSES) {
    expect(re.test(`agentTask.${s}`)).toBe(false);
    expect(re.test(`agentTask.${s}.reviewed`)).toBe(false);
    expect(re.test(`agentTask.${s}.linked`)).toBe(false);
  }
});

test("inline captureAgentOutput is scoped to running rows", async () => {
  const menu = await getViewItemContextMenu();
  const inline = menu.find(
    (i) => i.command === "commandCentral.captureAgentOutput" && i.group === "inline",
  );
  expect(inline).toBeDefined();
  const re = viewItemRegex(inline?.when);
  expect(re.test("agentTask.running")).toBe(true);
  for (const s of DEAD_STATUSES) {
    expect(re.test(`agentTask.${s}`)).toBe(false);
  }
});
```

Optional belt-and-suspenders (regression guard at the row level) — extend
`test/tree-view/agent-status-history-native-rows.test.ts`: assert that a completed
leaf's `contextValue` is `agentTask.completed*` and document that the inline
focus/capture `when` no longer matches it (the package.json tests above are the
authoritative lock; this keeps the doctrine co-located with the History row tests).

---

## 6. Action list summary (answers the deliverable's two explicit asks)

**Actions shown on a History/completed/dead row today:**
- Inline icons: `focusAgentTerminal` ⚠️, `captureAgentOutput` ⚠️, `viewAgentDiff`,
  `removeAgentTask`, (`markStaleAgentFailed` on stale, `restartAgent` on failed).
- Right-click: `viewAgentDiff`, `openAgentDirectory`, `restartAgent`,
  `resumeAgentSession`, `removeAgentTask`, `markAgentReviewed`.
- Single-click: View Changes (`viewAgentDiff`).

**P0/P1 scoping bugs:** F1 `focusAgentTerminal` (P1) and F2 `captureAgentOutput` (P1),
both inline, both gated only by `^agentTask\.` so they leak onto all dead rows. **No P0.**

---

## 7. Verification commands (post-fix)

```bash
just test-unit                                   # fast lock incl. menu-contribution tests
bun test test/package-json/agent-menu-contributions.test.ts
bun test test/tree-view/agent-status-history-native-rows.test.ts
just check                                        # biome + tsc + knip (package.json valid JSON)
```

---

## 8. Why not applied here

This task runs under the **review-mode contract** ("leave the working tree untouched")
and the user's lead framing is a *read-only* audit with the provider file under active
review. The recommended fix is `package.json`-only and therefore non-conflicting with
the provider review, but I have **not** modified the tree — the exact before/after diff
(§4) and tests (§5) are copy-paste-ready for a one-shot apply by the implementing lane.
Estimated change: 2 one-token `when` edits + 2 tests; no provider changes; no
capability lost for the common dead-row workflow.
