# Fable Lane — Command Central provider split hardening

Task ID: cc-provider-split-hardening-20260610
Role: developer
Model: fable

## Context
Command Central rc50 is cut and locally committed. The extension is getting bloated. The biggest source file is `src/providers/agent-status-tree-provider.ts` (~9k LOC), with many tree-view tests.

## Objective
Make one small, safe, production-quality refactor that reduces provider bloat without changing behavior.

## Scope
Allowed source scope:
- `src/providers/agent-status-tree-provider.ts`
- new helper/module files under `src/providers/` or `src/utils/` only if they extract cohesive logic from that provider
- focused tests under `test/tree-view/` that directly cover the extracted behavior

Do not touch release artifacts, VSIX files, package version, generated prerelease-gate receipts, or unrelated services.

## Requirements
- Start by reading `package.json` contributes, `src/extension.ts`, and the current provider hotspots.
- Prefer extraction over rewrite. Keep public behavior and command IDs unchanged.
- Preserve agent/model neutrality; no Claude/Codex-specific assumptions.
- Run focused tests first, then `just test-unit` or the smallest meaningful gate.
- Commit locally if and only if tests pass.
- Write a receipt at `research/RESULT-cc-provider-split-hardening-2026-06-10.md` summarizing files changed, tests, and remaining bloat hotspots.

## Constraints
No push, no tag, no marketplace publish, no `--no-verify`, no dependency changes.
