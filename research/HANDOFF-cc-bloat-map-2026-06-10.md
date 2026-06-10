# Fable Lane — Command Central bloat map

Task ID: cc-bloat-map-20260610
Role: planner
Model: fable

## Context
Command Central rc50 is cut and locally committed. Mike asked for continued hardening because the extension feels bloated and needs refinement.

## Objective
Produce a concise, evidence-backed bloat/refinement map for the next 3-5 safe iterations.

## Scope
Read-only analysis except the required receipt file.
Inspect:
- largest files and modules
- activation path and `src/extension.ts`
- Agent Status provider/service boundaries
- test suite duplication
- `knip`, package scripts, and dependency/config risk if locally available

## Deliverable
Write `research/RESULT-cc-bloat-map-2026-06-10.md` with:
1. Top 5 bloat/refinement targets, ranked by risk-adjusted payoff.
2. Suggested non-overlapping agent lanes for each target.
3. Any dead-code/dependency candidates, with evidence.
4. Gates required before release.

## Constraints
Do not modify source, tests, package files, release artifacts, or config. No push, no tag, no publish, no external network.
