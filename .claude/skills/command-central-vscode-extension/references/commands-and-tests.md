# Commands and Tests

Command reference and testing strategy for Command Central development.

## Standard Recipes

Command Central follows the cross-project five-recipe standard. Always prefer `just <recipe>` over running bun/biome/tsc directly.

| Recipe | What It Does | When to Use |
|--------|-------------|-------------|
| `just check` | biome ci + tsc + knip (read-only) | After changes, before committing |
| `just fix` | Auto-fix lint + format | When biome reports fixable issues |
| `just test` | Full test suite (~5s) | Before pushing, after significant changes |
| `just ready` | fix + check + test | One-shot pre-push gate |
| `just ci` | Strict gate (warnings = errors) | Mirrors what CI runs |

Aliases: `just t` = test, `just f` = fix, `just r` = ready.

## Test Sub-Commands

For faster iteration during development:

| Command | Time | Scope |
|---------|------|-------|
| `just test-unit` | ~0.5s | Unit tests only (450+ tests) |
| `just test-integration` | ~3s | Integration + discovery E2E |
| `just test-validate` | <1s | Ensures all tests are in partitions (no orphans) |
| `just test-watch` | continuous | TDD watch mode |

### Targeted Test Execution

Run a specific test file or directory:

```bash
bun test test/tree-view/agent-status-tree-provider-rendering.test.ts
bun test test/tree-view/
bun test test/integration/tasks-json-startup-smoke.test.ts
```

Always run targeted tests first, then broaden to `just test-unit` or `just test` after the targeted tests pass.

## Tree-View Tests

Located in `test/tree-view/`. These test the Agent Status tree provider:

| File | What It Tests |
|------|--------------|
| `agent-status-tree-provider.test.ts` | Core provider functionality |
| `agent-status-tree-provider-rendering.test.ts` | Icons, metadata, descriptions |
| `agent-status-tree-provider-discovery.test.ts` | Discovery mechanism, agent merging |
| `agent-status-tree-provider-health.test.ts` | Health checks, liveness signals |
| `agent-status-pending-review-truth.test.ts` | Pending-review receipt overlay logic |
| `agent-status-handoff-file.test.ts` | Declared handoff file validation |
| `agent-status-review-and-handoff.test.ts` | Review queue + handoff interaction |
| `agent-status-tree-provider-read-registry.test.ts` | tasks.json parsing |
| `openclaw-task-nodes.test.ts` | OpenClaw task rendering in tree |

### Test Helper Base

`test/tree-view/_helpers/agent-status-tree-provider-test-base.ts` provides:

- Module mocks for `fs`, `child_process`, `port-detector`.
- `createProviderHarness()` — factory for test provider instances.
- `createMockTask()`, `createMockRegistry()` — mock data factories.
- `loadAgentStatusFixture()`, `loadDogfoodFixture()` — fixture loaders.

### Test Fixtures

`test/fixtures/agent-status/`:

- `alpha-beta-12.json` — 12 running tasks across 2 projects (version 2).
- `dogfood-live-tasks.json` — real-world dogfood snapshot.
- `screenshot-stale-running.json` — stale task examples.

## Integration Tests

Located in `test/integration/`:

| File | What It Tests |
|------|--------------|
| `tasks-json-startup-smoke.test.ts` | Empty/missing tasks.json handling |
| `installed-vsix-proof-suite.ts` | Full extension lifecycle with installed VSIX |
| `agent-notification-ux.test.ts` | Notification behavior |
| `cross-repo-smoke.test.ts` | Multi-project scenarios |

## Proving the Extension Works

Three levels of confidence, in increasing order:

### 1. Unit/Integration Tests (Automated)

Run `just test`. Covers code correctness but cannot verify visible UI state.

### 2. Installed-VSIX Proof (Semi-Automated)

Build and install the extension, then run the proof suite:

```bash
just dist
code --install-extension releases/command-central-*.vsix
just test-installed-vsix-agent-status
```

This exercises the extension in a real VS Code instance with `--extensionDevelopmentPath`.

### 3. Visual Verification (Manual or Computer Use)

If Computer Use or browser automation is available, verify visible VS Code sidebar state directly — check that the Agent Status tree renders the expected nodes, icons, and badges. Otherwise, rely on integration-test API snapshots and the installed-VSIX proof suite.

## Pre-Release Validation

Before cutting a release:

```bash
just prerelease-gate    # Cross-repo smoke + compatibility checks
just prerelease         # Gate + build prerelease artifact
just cut-preview        # Full preview release workflow
```

`just prerelease-gate` is the minimum bar. It runs cross-repo compatibility checks that `just test` alone does not cover.

## Pre-Flight Checklist

Before submitting any change:

- [ ] `just test-unit` passes
- [ ] `just check` passes (no lint/format issues)
- [ ] `just test` passes (full suite)
- [ ] Build succeeds: `bun run build`
- [ ] All imports use `.js` extension
- [ ] `external: ['vscode']` preserved in build config
- [ ] VSIX size reasonable (< 100KB)
