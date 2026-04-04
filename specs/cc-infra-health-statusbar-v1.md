ULTRATHINK. Use Claude Opus-level reasoning.

# Spec: Command Central Infrastructure Health Status Bar (Phase 1)

## Goal

Add the thinnest useful infrastructure health visibility to Command Central without building the
full Phase 2 tree yet.

This is Phase 1 only:
- lightweight status bar item
- fast readiness signal first
- optional enrichment from shared health summary JSON if present

## Context

Research doc: `research/MONITORING-ARCHITECTURE-RESEARCH.md`
Recommended Phase 1:
- CC status bar polling `/readyz`
- shared `health-summary.json` for richer detail

Do NOT build the full Infrastructure Health tree view in this task.

## Required behavior

### 1. New status bar service

Add a new status bar item for infrastructure health.
Suggested text patterns:
- `$(pulse) OpenClaw OK`
- `$(warning) OpenClaw WARN`
- `$(error) OpenClaw DOWN`

Behavior:
- poll every 30s
- primary signal: local gateway readiness / health
- if shared health summary exists, use it to enrich severity + tooltip

### 2. Data sources

Use the cheapest signal first.

Preferred order:
1. `http://127.0.0.1:18789/readyz` or an existing helper/CLI equivalent if already present in repo patterns
2. Optional: read `~/.openclaw/workspace/dashboard/data/health-summary.json` for richer tooltip/details

Do not run `openclaw doctor` every 30 seconds from the extension.
Do not run the full health gate in the extension polling loop.

### 3. Tooltip

Tooltip should be genuinely useful. Include:
- gateway ready/unreachable
- if health summary exists: overall summary
- channel summaries (Discord / BlueBubbles) if available
- last generated timestamp from summary if available
- a hint about where the canonical data comes from

### 4. Command on click

Clicking the status bar item should do something useful but minimal.
Good options:
- open `dashboard.partnerai.dev`
- or open the dashboard webview if there is an obvious existing pattern

Prefer the simplest useful action already consistent with the extension.

### 5. Failure behavior

- If the gateway check fails: show DOWN state, do not spam errors
- If the summary JSON is missing: still work from readiness only
- If JSON is malformed: ignore it and continue with readiness only

## Files likely to change

- `src/services/` (new status bar service)
- `src/extension.ts` (register/dispose service)
- tests under `test/services/`

## Constraints

- No new tree view
- No command palette feature explosion
- No alert routing
- No dashboard implementation in this task
- Keep polling cheap and bounded

## Verification

Before finishing:
1. tests for the new status bar service pass
2. existing status bar services still work
3. no command/activation regressions
4. tooltip/output reflect gateway down vs warn vs ok states

## Completion note

Write `.oste-report.yaml` with:
- files changed
- exact poll source used (`/readyz`, summary JSON, both)
- click action used
- tests run
