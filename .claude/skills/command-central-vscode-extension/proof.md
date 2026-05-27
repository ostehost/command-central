# Proof: command-central-vscode-extension

## Provenance

- **Origin:** Local-only. Written for this repository; not forked or ported from upstream.
- **Canonical path:** `command-central/.claude/skills/command-central-vscode-extension/`
- **Staging artifact:** `~/.codex/skills/command-central-vscode-extension/` (build output from `skill-creator`; non-canonical)
- **Created:** 2026-05-27
- **Last reviewed:** 2026-05-27

## Purpose

Guides agents working on the Command Central VS Code extension. Covers Agent Status tree provider logic, data source integration (tasks.json, pending-review, reviewed-tasks, OpenClaw, discovery), testing strategies, and two operational scripts for auditing and resetting Agent Status state.

## Scope

Repo-specific. Only useful when working on Command Central. Not a shared operator skill.

## Validation

```
quick_validate.py    PASS
bash -n scripts/*.sh PASS
shellcheck           PASS (0 warnings)
```

Fixture tests (39/39):
- Audit: JSON output, human-readable, pending-review breakdown (active/reviewed/quarantined), OpenClaw unavailable graceful degradation, no-tasks-file handling
- Reset: dry-run immutability, running-task refusal (pre-lock and under-lock), full atomic pending-review backup (including reviewed/ and quarantined/ subdirs), scaffold recreation, backup collision protection, stale lock auto-removal, lock release on exit
- Targeted: refused resets leave no empty backup directories

## Safety Review

### Scripts

| Check | Result |
|-------|--------|
| No writes to VS Code settings.json | PASS |
| No process killing (kill/pkill/killall) | PASS |
| No hardcoded `/Users/ostehost` paths | PASS |
| `--apply` required for any mutation | PASS |
| Running tasks refused by default | PASS |
| Under-lock re-check before mutation | PASS |
| Atomic pending-review move (mv, not cp+delete) | PASS |
| Backup collision protection (random suffix) | PASS |
| Launcher lock compatible with tasks-lock.sh | PASS |
| No `allowed-tools` field (no elevated permissions) | PASS |

### Documentation Accuracy

References verified against source on 2026-05-27:
- AgentTaskStatus enum matches `agent-status-tree-provider.ts:136`
- CLEARABLE set matches `agent-task-registry.ts:9` (no contract_failure)
- Pending-review schema matches `pending-review.sh:263` (snake_case, awaiting_fixup)
- EventEmitter type matches `agent-status-tree-provider.ts:1288` (AgentNode | undefined | null)
- scheduleTreeRefresh semantics match `agent-status-tree-provider.ts:1606`
- OpenClawTaskService watch matches `openclaw-task-service.ts:121` (fs.watch on directory)
- Build toolchain matches `scripts-v2/lib/compiler.ts`

## Distribution

| Location | Role |
|----------|------|
| `.claude/skills/command-central-vscode-extension/` | Canonical, source-controlled, auto-discovered by Claude Code |
| OpenClaw workspace install | Installed from canonical via `openclaw skills install` |
| `~/.codex/skills/command-central-vscode-extension/` | Staging artifact (non-canonical, safe to remove) |
