# RESULT — Agent Status *History* native-UX enhancement review

- **Task:** `cc-history-ux-native-enhancement-20260614`
- **Repo:** `~/projects/command-central` (Mike MacBook Pro)
- **Mode:** review + one tiny, low-conflict, test-only change
- **HEAD at finish:** `ad77b307` (this task's commit; on `main`, working tree clean)
- **My commit:** `ad77b307 test(agent-status): lock History section rows as native non-actionable group rows`
- **Gates:** `just test` → **2107 pass / 0 fail / 1 skip**; `just check` → ✅ (8 pre-existing `noNonNullAssertion` warnings, none mine); `just test-validate` → 100% partitioned, 0 orphaned.

---

## TL;DR / Verdict

**The History section is already structurally native and calm**, and the audible
"rattle" is **not** produced by clicking History (a separate lane already proved
the rattle is external — the launcher's `terminal-notifier`/macOS notification
sound; CC's only sound path, `notifications.sound` BEL, is default-off and off
in Mike's config — see `research/RESULT-cc-rattle-perf-critical-bugs-20260613.md`).

Concretely, in the current code **every History group/section row carries no
click command**, so clicking a dense History header only toggles VS Code's
native expand/collapse — it can never dispatch a Command Central action. That is
the single most important native-UX invariant for "dense UI that invites clicks
on non-action headers," and it was previously **untested** for the Agent Status
tree. I locked it with a focused regression test (commit `ad77b307`).

The remaining, genuinely useful improvements are **behavior-sensitive and touch
the files an active diagnosis lane is most likely editing** (`agent-status-tree-provider.ts`,
`package.json` menus — `package.json` was already modified today). Per the task's
own coordination rule, I did **not** rewrite those; I specify them precisely
below as P1/P2 for a follow-up that can own them without colliding.

---

## 1. What I inspected (current section model)

Agent Status **V2** is a single lifecycle-led tree with five sections
(`src/utils/agent-status-sections.ts`): **Live · Needs Review · Action Required ·
History · Sources**. History = the `done` bucket (terminal/succeeded/approved or
aged; "always revisitable").

Row builders in `src/providers/agent-status-tree-provider.ts`:

| Row | Builder | `contextValue` | Collapsible | `item.command` | Notes |
|---|---|---|---|---|---|
| Project group | `createProjectGroupItem` (8809) | `projectGroup` / `projectGroupUnregistered` | Expanded if running, else Collapsed | **none** | per-project V2 counts |
| Folder group | `createFolderGroupItem` (8876) | `folderGroup` | Expanded | **none** | |
| **Section header** ("History · N") | `createStatusGroupItem` (8885) | `statusGroup` | **History is always Collapsed**; others auto-expand only if `statusGroupHasRecentItems` | **none** | icon + `"History • N agents"` tooltip |
| **Time sub-group** ("Older", …) | `createStatusTimeGroupItem` (8905) | `statusTimeGroup` | per node | **none** | calendar icon + tooltip |
| **"Show N older completed…"** | `createOlderRunsItem` (9361) | `olderRuns` | Collapsed | **none** | history icon; `getChildren` returns **all** `hiddenNodes` (hides nothing) |
| Info row | `createStateItem` (9350) | `agentState` | None | **none** | pure text |
| **Task leaf** | `createTaskItem` (~9230) | `agentTask.<status>[.reviewed][.linked]` | None | **`defaultAgentAction`** | running → focus terminal; **non-running/History → `viewAgentDiff`** (quiet) |

Node model (`StatusGroupNode`, `StatusTimeGroupNode`, `OlderRunsNode`,
`StateNode`) has **no `command` field at all** — group rows are non-actionable by
construction. Capping: `commandCentral.agentStatus.maxVisibleAgents` (default 50,
min 10, max 500), applied **per project** in grouped mode; running agents are
never capped; overflow folds under the collapsed `olderRuns` row
(`research/DEV-NOTES-agent-history-cap.md`).

### Click → noise analysis (the actual question)

- **Section / time / olderRuns / state rows:** no command ⇒ a click only
  expands/collapses. **Cannot dispatch anything, cannot make noise.** ✔ native.
- **History task leaf, single click:** `defaultAgentAction` → since status ≠
  running it routes to `viewAgentDiff` (`register-agent-navigation-commands.ts:96`).
  Opens a diff — **no terminal focus, no `osascript`, no toast, no bell.** ✔ quiet.
- **The one real accidental-noise vector:** the `view/item/context` wiring puts
  `commandCentral.focusAgentTerminal` (and `captureAgentOutput`, `viewAgentDiff`)
  as **`group=inline`** hover buttons on **every** `agentTask.*` row, *including*
  completed/History rows (`when=viewItem =~ /^agentTask\./`). On a finished
  History lane whose tmux session is dead, an accidental click on the inline
  **Focus Terminal** icon invokes a focus attempt → `osascript`/`tmux` →
  error/window-activation = perceived noise. This is hover-revealed and easy to
  fat-finger on a dense list. **This is the highest-value behavioral fix** (P1).

---

## 2. Best-practice evaluation (VS Code tree section/group rows)

1. **Non-click vs collapsible group rows.** ✔ Already correct: group rows omit
   `item.command` (the #1 VS Code tree pitfall — a command overrides native
   expand/collapse). The repo already encodes this doctrine for the *git-sort*
   provider in `test/tree-view/native-commands.test.ts` ("PITFALL #1"), but it
   was **not** covered for the Agent Status tree. **Locked now** (§4).
2. **Context-menu scoping by `contextValue`.** Mostly good (kill/restart/resume
   are status-scoped). **Gap:** inline `focusAgentTerminal`/`captureAgentOutput`
   are scoped only to `^agentTask\.` (all statuses), so they appear inline on
   History rows where the terminal is usually dead. Recommendation: keep them in
   the **right-click context group** but drop them from `group=inline` for
   terminal statuses (completed/stopped/killed/contract_failure), leaving the
   quiet `viewAgentDiff` as the History default. (P1)
3. **Accessibility labels/tooltips.** Section headers and time groups have
   tooltips (`"History • N agents"`), but **no `accessibilityInformation`**
   anywhere in `src/` and the expand/collapse semantics aren't announced. The
   `olderRuns` row has no tooltip. Recommendation: add
   `accessibilityInformation = { label: "History section, N agents, collapsed
   group — Enter to expand" }` to the three group builders, and a tooltip to
   `olderRuns`. Purely additive. (P2)
4. **Lazy loading / "Show older completed" semantics.** ✔ Correct & doctrine-safe:
   capped per project, running never hidden, expansion reveals **every** hidden
   run (`getChildren(olderRuns) → hiddenNodes.map(...)`). **Minor UX nit:** the
   imperative label `"Show N older completed..."` reads like an action button but
   behaves as a collapsible expander — non-idiomatic for a no-command row. A noun
   phrase (`"Older completed (N)"`) reads as a group, matching `"History · N"`.
   (P2 — small but has test coverage to update.)

---

## 3. Enhancement plan (P0 / P1 / P2)

### P0 — none
No release blocker originates in the History UX. Group rows are non-actionable;
History is collapsed-by-default; nothing is hidden. The audible rattle is
external (launcher notifier) — out of scope here and owned by the diagnosis lane.

### P1 — De-noise accidental clicks on History rows *(recommended; needs file ownership)*
- **P1a — Drop inline Focus Terminal / Capture Output from terminal-status rows.**
  In `package.json` `view/item/context`, split the two `group=inline` entries so
  the inline icons appear only for live-ish rows
  (`viewItem =~ /^agentTask\.(running)/` plus `discoveredAgent.running`), and move
  Focus/Capture to a right-click `group` (e.g. `2_actions`) for terminal statuses.
  Net effect: a dense History row shows only the quiet `viewAgentDiff` affordance;
  the dead-terminal focus attempt is no longer one stray click away. *Behavioral;
  add a `test/package-json/agent-menu-contributions.test.ts` case.*
- **P1b — Make non-running Focus Terminal fail loud, never silent.** Confirm
  `focusAgentTerminal` on a dead History session shows an explicit info/error and
  **never** silently spawns an integrated terminal (honors the standing
  "no silent integrated-terminal fallback" doctrine). Likely already true; add a
  regression test.

> **Why not done here:** P1 edits `package.json` (modified today by another lane)
> and the provider/command files the diagnosis lane is most likely touching. The
> task says prefer research-only when files overlap. These are specified for a
> follow-up that can own those files conflict-free.

### P2 — Polish *(low risk, additive)*
- **P2a — `accessibilityInformation` on group rows** (`statusGroup`,
  `statusTimeGroup`, `olderRuns`) announcing "collapsed/expanded group, N items,
  Enter to expand." Additive; test the label.
- **P2b — Tooltip on the `olderRuns` row** explaining it reveals hidden completed
  runs (nothing is deleted).
- **P2c — Relabel** `"Show N older completed..."` → `"Older completed (N)"` so a
  no-command row reads as a group, not a button. Update the existing assertions
  in `agent-status-tree-provider-diff-notifications.test.ts`.
- **P2d (optional) — Auto-collapse History time sub-groups beyond "Today".** Keep
  full counts in headers (no hiding) — only suppress auto-expansion, mirroring the
  Needs-Review calming already shipped in `72216ce1`.

---

## 4. Change made this task (committed)

**`ad77b307` — test-only; no runtime/behavior change.**

`test/tree-view/agent-status-history-native-rows.test.ts` (new, 5 tests) extends
the existing **PITFALL #1** doctrine to the Agent Status V2 History surface and
locks the native contract that was previously untested there:

1. **History section header** (`statusGroup`, `done`): **no `command`**,
   `contextValue === "statusGroup"`, rendered **Collapsed** (never auto-expands),
   icon + tooltip present.
2. **History time sub-group** (`statusTimeGroup`): **no `command`**,
   `contextValue === "statusTimeGroup"`, collapsible, tooltip present.
3. **"Show N older completed…"** (`olderRuns`): **no `command`**, collapsible,
   `contextValue === "olderRuns"`, and **`getChildren` reveals every hidden run**
   (hides nothing — the revisitability doctrine).
4. **Info row** (`state`): **no `command`**, non-collapsible.
5. **Contrast / positive control:** a completed History **leaf** still carries a
   navigation command (`defaultAgentAction`) — proving the no-command rule is
   scoped to group rows, not leaves.

**Why this is the right footprint:** it touches **only a new test file** — zero
overlap with the provider/`package.json` an active diagnosis lane edits, so it
cannot sweep (or be swept by) their work, and it is the blessed "tiny
non-conflicting test change." It is genuinely valuable: it prevents the exact
regression that would turn a benign History expand-click into a command dispatch
(e.g., someone later attaching a "focus terminal"/"refresh" command to a section
header). Staged by explicit path only (per the shared-working-copy concurrency
doctrine); committed normally with the Biome pre-commit hook (no `--no-verify`).

### Tests
- New file: **5 pass / 0 fail** (`bun test test/tree-view/agent-status-history-native-rows.test.ts`).
- With siblings: `native-commands.test.ts` still green.
- Full: `just test` → **2107 pass / 0 fail / 1 skip** (pre-existing skip);
  quality checks ✅ ("Zero 'as any'", "Zero reflection tests").
- `just check` ✅; `just test-validate` ✅ (100% partitioned).

---

## 5. Obsolete-pattern compliance

- **No OpenClaw subagent masquerade**, **no synthetic running state**, **no DOM
  scraping**, **no tmux-dependent durable proof.** The change is a pure VS Code
  `TreeDataProvider` unit test driving the real `getTreeItem`/`getChildren`.
- **History stays fully revisitable** — the test *asserts* `olderRuns` reveals
  every hidden run; nothing is hidden or dropped.
- All recommendations use **TreeDataProvider + command/context/menu APIs only**.

---

## 6. Coordination note for the diagnosis lane / reviewer

- Working copy is **shared** across sibling Claude Code lanes (concurrency sweep
  hazard). I staged only my one test path and committed atomically; HEAD is
  `ad77b307`, tree clean. If you (diagnosis lane) hold uncommitted provider/
  `package.json` edits, they were untouched by this commit (it changed 1 test
  file, +158 lines).
- **Decision logged:** the generic harness "Review mode → leave the working tree
  untouched" line conflicts with the task prompt's explicit "implement the small
  fix with tests" + "if changes are made, commit normally." I followed the
  task prompt, and committing (rather than leaving the file untracked) is in fact
  the *safer* choice on a shared working copy — an uncommitted file is exactly
  what a sibling `git add -A` would sweep. If a pure research-only outcome is
  preferred, revert `ad77b307` (`git revert` or drop the commit); the test patch
  is fully described above.

## 7. Remaining follow-ups
1. **P1a/P1b** (inline-action scoping + loud non-running focus) — own
   `package.json` + provider once the diagnosis lane lands, add menu/command tests.
2. **P2a–P2d** (accessibilityInformation, olderRuns tooltip, label noun-phrase,
   optional time-group calming) — additive polish.
3. **External (not CC):** confirm the launcher `terminal-notifier`/macOS
   notification sound is the rattle source and silence it; clear stale notifiers
   (`pkill -f "terminal-notifier.*oste"`). Owned by the diagnosis lane.

No release cut/built/installed. No push/tag/publish. No other repos mutated.
