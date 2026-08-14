# SPEC: Agent Status Truth UX v1

> **Date:** 2026-04-10
> **Status:** Advisory (do not implement without review)
> **Scope:** Agent Status tree view — state model, grouping, counts, and filtering
> **Target file:** `src/providers/agent-status-tree-provider.ts`

---

## Problem Statement

The Agent Status tree view is noisy and misleading. It collapses five semantically
distinct lane states into three display groups (`running` / `done` / `attention`),
producing aggregate counts like "5 working / 4 stuck" that conflate:

1. **Actively executing** lanes with **materially complete but orchestration-incomplete** lanes
2. **Actionable attention items** (review pending, fixup needed) with **stale historical failures**
3. **Current-host** work with **other-host** historical entries

The `toDisplayTask()` runtime overlay (line ~1294) already acknowledges the truth
gap — it exists precisely because `tasks.json` metadata becomes stale due to lifecycle
races. But the UI groups don't surface the distinctions that overlay computes.

### Concrete examples from live work

| Lane ID | Git truth | Orchestration metadata | Display | Correct state |
|---------|-----------|----------------------|---------|---------------|
| `ghl-stale-session-reuse-mainroof-v1` | Executed successfully, commits present | `awaiting_fixup` in orchestrator | Shows as `completed` or `attention` | **Awaiting fixup** |
| `ghl-review-contract-truth-v1` | Executed, in review flow | Still in review pipeline | Shows as `done` | **Review pending** |
| `ghl-completion-range-truth-advisory-v1` | Materially done in git | Orchestration metadata lagging | Shows as `running` or `completed_dirty` | **Materially complete** |
| `ghl-single-launcher-dogfood-spec-v1` | Materially done in git | Metadata lagging | Shows as `running` | **Materially complete** |
| Interactive team lanes | Healthy, active | Stream files may be missing | Could show as `stuck` | **Healthy (interactive)** |
| Old hub lanes | Completed weeks ago | Still in registry | Mixed with current work | **Stale historical** |

---

## Current Architecture (Audit Summary)

### State Model

```
AgentTaskStatus (8 values):
  running | stopped | killed | completed | completed_dirty |
  completed_stale | failed | contract_failure

AgentStatusGroup (3 values):
  running | done | attention

Mapping:
  running                              → running
  completed, completed_dirty, completed_stale → done
  stopped, killed, failed, contract_failure   → attention
```

### Status Derivation Priority (`toDisplayTask()`, line ~1294)

| Priority | Signal | Result |
|----------|--------|--------|
| 1 | Stale transition detected | `completed_stale` |
| 2 | Stream file terminal event | `completed` or `failed` |
| 3 | Process health alive | `running` (unchanged) |
| 4 | `exit_code = 0` | `completed` |
| 4 | `exit_code != 0` | `failed` |
| 4 | `completed_at` exists | `completed` |
| 5 | Git commits since start | `completed_dirty` |
| 6 | Default | `stopped` |

### What exists but isn't surfaced

- **`ReviewTracker`** service (`src/services/review-tracker.ts`) — tracks reviewed-tasks.json but doesn't feed into status groups
- **`completed_dirty`** status — distinguishes "commits exist but no completion signal" but groups it with clean `completed`
- **Age-based collapse thresholds** — `done` after 24h, `attention` after 48h — but these are visibility heuristics, not semantic groups
- **`completedTaskLimit`** (default 10) + `OlderRunsNode` — caps visible completed tasks but doesn't distinguish recency semantically

### What doesn't exist

- **No host identification** — no hub vs. node distinction, no hostname field, no host-based grouping
- **No "awaiting fixup" or "review pending" status** — these orchestration states have no representation
- **No `.oste-report.yaml` or handoff file detection** — the code doesn't check for orchestration deliverables
- **No status-based filtering** — only project filtering exists
- **No "materially complete" concept** — no way to distinguish "done in git" from "done in orchestration"

---

## Proposed State Model

### New: 5-tier display groups

Replace the 3-group model with 5 semantic tiers that match how operators actually
triage work:

```
AgentDisplayTier:
  1. active       — Currently executing (proven live process or recent stream activity)
  2. needs_action — Requires human attention NOW (fixup, review, contract failure, fresh failure)
  3. limbo        — Materially complete but orchestration-incomplete (dirty exit, stale, metadata lag)
  4. done         — Clean completion with matching orchestration state
  5. historical   — Old entries (age > threshold) regardless of terminal status
```

### Status-to-tier mapping

| Status | Tier | Condition |
|--------|------|-----------|
| `running` + process alive | `active` | Process health confirmed |
| `running` + process dead + recent | `limbo` | Metadata stale, not yet resolved |
| `running` + process dead + old | `historical` | Abandoned metadata |
| `completed` | `done` | Clean exit |
| `completed_dirty` | `limbo` | Commits exist, no completion signal |
| `completed_stale` | `limbo` or `historical` | Age-dependent |
| `failed` (age < 48h) | `needs_action` | Fresh failure needing triage |
| `failed` (age >= 48h) | `historical` | Old failure, likely triaged |
| `contract_failure` (age < 48h) | `needs_action` | Missing deliverable |
| `contract_failure` (age >= 48h) | `historical` | Old contract issue |
| `stopped` (age < 24h) | `needs_action` | Unexpected stop, investigate |
| `stopped` (age >= 24h) | `historical` | Old stop |
| `killed` | `historical` | Intentional kill, archival |

### New statuses to add (optional, high-value)

| Status | Signal | Tier |
|--------|--------|------|
| `awaiting_review` | `ReviewTracker` has entry + not yet marked reviewed | `needs_action` |
| `awaiting_fixup` | Orchestrator metadata says fixup needed (new field in tasks.json) | `needs_action` |
| `materially_complete` | Git commits exist + handoff file exists + orchestration not yet reconciled | `limbo` |

These are optional because they require upstream orchestrator cooperation. The tier
system works without them by using the age-based heuristics above.

---

## Proposed UI Changes

### 1. Tree structure and grouping

**Current:**
```
Agent Status (5 working · 1 attention · 3 done)
  └─ ProjectGroup
       ├─ running (sync~spin)
       │    └─ task-a
       │    └─ task-b
       ├─ done (check)
       │    └─ task-c
       │    └─ task-d
       └─ attention (warning)
            └─ task-e
```

**Proposed:**
```
Agent Status (2 active · 1 action · 2 limbo)
  └─ ProjectGroup
       ├─ Active (2) — sync~spin, yellow
       │    └─ task-a (running, 3m ago)
       │    └─ task-b (running, 12m ago)
       ├─ Needs Action (1) — warning, orange
       │    └─ task-e (contract_failure, 2h ago)
       ├─ Limbo (2) — question, blue        [NEW]
       │    └─ task-f (completed_dirty, 45m ago)
       │    └─ task-g (completed_stale, 2h ago)
       ├─ Done (3) — check, green            [collapsed by default]
       │    └─ task-c
       │    └─ task-d
       │    └─ task-h
       └─ Historical (4) — archive, grey     [collapsed by default, NEW]
            └─ task-i (failed, 3d ago)
            └─ task-j (completed, 5d ago)
            └─ ... Show 2 more
```

### 2. Aggregate counts (view title / badge)

**Current:** `"5 working · 1 attention · 3 done"`

**Proposed:** `"2 active · 1 action · 2 limbo"`

Rules:
- **Only count active + needs_action + limbo** in the badge — these are actionable
- **Never count done or historical** in the badge — they are resolved
- If all counts are zero: show "idle" instead of "0 active · 0 action · 0 limbo"
- Badge tooltip shows full breakdown including done/historical counts

### 3. Default collapse behavior

| Tier | Default state | Rationale |
|------|--------------|-----------|
| `active` | Expanded | Operator needs to see what's running |
| `needs_action` | Expanded | Requires immediate attention |
| `limbo` | Expanded | Ambiguous state, needs triage |
| `done` | Collapsed | Resolved, reference only |
| `historical` | Collapsed | Archive, rarely needed |

### 4. Icons and colors

| Tier | Icon | Color | ThemeIcon |
|------|------|-------|-----------|
| `active` | Spinning sync | Yellow | `sync~spin` |
| `needs_action` | Warning triangle | Orange | `warning` |
| `limbo` | Question mark | Blue | `question` |
| `done` | Checkmark | Green | `check` |
| `historical` | Archive box | Grey | `archive` |

Per-status icons within tiers remain as-is (e.g., `failed` still shows `error` icon
within the `needs_action` group).

### 5. Host location (hub vs. node)

**Problem:** No hostname field exists in `tasks.json` today.

**Proposed — Phase 1 (inference, no schema change):**
- Derive host from `project_dir` path patterns:
  - `/Users/ostehost/...` → "macbook" (local node)
  - `/home/ostehost/...` → "hub" (remote)
  - Or use `os.hostname()` at task creation time if ghostty-launcher can be updated
- Display as subtle suffix on project group: `ghostty-launcher (macbook)` vs `ghostty-launcher (hub)`
- Add filter: "Show this host only" / "Show all hosts"

**Proposed — Phase 2 (schema change, requires orchestrator update):**
- Add `hostname` field to task schema in tasks.json v3
- Top-level grouping toggle: `Group by Host > Project > Tier` vs `Group by Project > Tier`

### 6. Filtering

**New filter commands (additive to existing project filter):**

| Command | Effect |
|---------|--------|
| `commandCentral.agentStatus.filterActive` | Show only `active` + `needs_action` + `limbo` |
| `commandCentral.agentStatus.filterActionable` | Show only `needs_action` + `limbo` |
| `commandCentral.agentStatus.showAll` | Remove all filters |
| `commandCentral.agentStatus.filterByHost` | Show only selected host |

**Quick filter buttons** in the view title bar (VS Code view actions):
- "Actionable only" toggle (hides done + historical)
- "This host only" toggle

---

## Proven vs. Guessed Signals

This distinction is critical. The spec must not treat guessed signals as proven.

### Proven signals (high confidence, use for status determination)

| Signal | Source | Confidence |
|--------|--------|------------|
| Process alive (ps/lsof) | ProcessScanner | **High** — real-time |
| Stream file terminal event | JSONL parse | **High** — written by agent |
| `exit_code` | tasks.json | **High** — set by launcher |
| `completed_at` timestamp | tasks.json | **High** — set by launcher |
| Git commits since `start_commit` | git rev-list | **High** — immutable evidence |
| Stream file mtime | filesystem | **Medium-high** — clock-dependent |

### Guessed signals (use for hints/badges, not status override)

| Signal | Source | Confidence | Risk |
|--------|--------|------------|------|
| Stuck threshold (no stream activity) | Timer heuristic | **Medium** — false positives on interactive lanes | May flag healthy interactive sessions |
| Path-based host inference | `project_dir` | **Low-medium** — breaks with remote mounts, containers | Wrong host label |
| "Materially complete" (commits + no completion) | Inference | **Medium** — commits don't prove deliverable quality | May hide real failures |
| Age-based tier assignment | Timer | **Medium** — arbitrary thresholds | May archive unresolved items |

### Recommendation

- **Tier assignment** should use proven signals for `active` (process alive) and `done` (exit_code=0 + completed_at)
- **Tier assignment** may use guessed signals for `limbo` (commits exist but no completion) and `historical` (age threshold)
- **`needs_action`** should only be assigned from proven failure signals (exit_code != 0, contract_failure) or explicit orchestrator state (awaiting_review, awaiting_fixup)
- **Guessed signals** should show as badges/tooltips, not as status overrides

---

## Implementation Slice Recommendation

### Slice 1: "Limbo tier + better counts" (smallest high-leverage change)

**Scope:** ~200 lines changed in `agent-status-tree-provider.ts` + `agent-counts.ts`

**Changes:**
1. Add `limbo` to `AgentStatusGroup` enum (alongside `running`, `done`, `attention`)
2. Map `completed_dirty` and `completed_stale` to `limbo` instead of `done`
3. Map `running`-but-process-dead to `limbo` instead of keeping in `running`
4. Update `AgentCounts` to add `limbo: number`
5. Update badge to show `"N active · M action · L limbo"` (exclude done count)
6. Add `question` icon (blue) for limbo group node
7. Default-collapse `done` group

**Why this slice:**
- Fixes the most misleading signal: "5 working" when 2 are actually in limbo
- Fixes the second most misleading signal: lumping dirty/stale exits with clean completions
- No schema changes required — purely display-layer
- No new data sources — uses signals already computed by `toDisplayTask()`
- Backward compatible — existing status values unchanged
- Testable immediately against live orchestration data

**What it defers:**
- Historical tier (can be added as follow-up by splitting `done` on age)
- Host grouping (requires hostname signal, either inferred or added to schema)
- New statuses (awaiting_review, awaiting_fixup — require orchestrator cooperation)
- Status-based filtering commands (can layer on top of tier model)

### Slice 2: "Historical tier" (follow-up)

Add age-based split of `done` and `attention` into `historical`:
- `done` items older than 24h → `historical`
- `attention` items older than 48h → `historical`
- `historical` group collapsed by default
- Badge excludes historical count

### Slice 3: "Host grouping" (requires orchestrator change)

Add `hostname` to task schema, group by host at top level.

---

## Migration Notes

- The `AgentStatusGroup` enum is used in sorting (`compareSortableAgentNodes`), icon
  mapping (`getStatusGroupIcon`), and tree structure (`StatusGroupNode`). All three
  must be updated together.
- The `AgentCounts` interface is used in badge rendering and the summary node. Adding
  `limbo` requires updating both.
- The `completedTaskLimit` and `OlderRunsNode` logic should apply to `done` +
  `historical` tiers, not to `limbo` (limbo items should always be visible).
- Auto-refresh timer should remain active when `limbo` count > 0 (these may resolve).

---

## Open Questions

1. **Should `limbo` items auto-resolve?** If a limbo item sits for >4h with no
   orchestration update, should it auto-transition to `done` (optimistic) or
   `needs_action` (pessimistic)? Recommend: keep in `limbo` until explicit resolution
   or age-out to `historical`.

2. **Interactive lane false positives:** The stuck threshold (15min default,
   configurable) will flag healthy interactive sessions. Should interactive lanes
   (detected by absence of agent-mode flags) be exempt from stuck detection?
   Recommend: yes, exempt discovered interactive sessions from stuck transition.

3. **Should `contract_failure` be split by age?** Currently always `needs_action`.
   Old contract failures are noise. Recommend: age-split like other terminal statuses.

4. **ReviewTracker integration:** The `ReviewTracker` already persists review state.
   Should `awaiting_review` be a first-class tier-assignment signal? Recommend: yes,
   in Slice 2 or 3, not Slice 1.
