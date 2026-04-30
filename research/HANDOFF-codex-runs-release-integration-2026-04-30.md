# Handoff: Codex Runs Visibility MVP Release Integration

Date: 2026-04-30
Repo: `/Users/ostemini/projects/command-central`
Audience: main OpenClaw agent
Status: ready for complete review, release integration, and hub/node propagation

## Objective

Integrate the Codex/Symphony visibility MVP into the next VS Code-native Command Central extension
release, verify it on the hub and node, and send a feedback round back before the next iteration.

This work must remain Command Central visibility-only. Command Central is the operator UI, not a
scheduler. Do not add lifecycle authority, Codex launches, retry queues, tracker writes, file
crawlers, JSONL parsing, dashboard surfaces, or workspace hooks.

## Current Changed Files

Review these files completely before release integration:

- `src/services/codex-run-observer-service.ts`
- `src/providers/agent-status-tree-provider.ts`
- `test/services/codex-run-observer-service.test.ts`
- `test/tree-view/openclaw-task-nodes.test.ts`
- `research/SPEC-codex-symphony-visibility-layer-2026-04-29.md`
- `research/HANDOFF-codex-run-observer-mvp-2026-04-29.md`
- `research/HANDOFF-codex-runs-release-integration-2026-04-30.md`

Expected `git status --short` before committing should show those files only unless release tooling
intentionally creates version/release artifacts.

## What Changed

Projection safety:

- `CodexRunObserverService.project(...)` remains pure and caller-input based.
- Launcher-only Codex rows are never join targets. This prevents unrelated launcher-only rows from
  collapsing when they share broad session identities such as `agent-ghostty-launcher`, or when one
  prompt/title happens to match another launcher id.
- Session identity can still enrich an existing OpenClaw/TaskFlow owner row.
- OpenClaw/TaskFlow owner rows remain lifecycle-authoritative when present.

VS Code-native surface:

- The Agent Status root still shows a single `Codex Runs` container.
- Expanded Codex run rows now expose concrete detail children for:
  - normalized display `Status`
  - raw `Source status`
  - `Lifecycle owner`
- This keeps important provenance visible in the native VS Code tree instead of hiding it only in
  hover text.

Docs:

- The MVP spec and handoff now explicitly state that launcher joins may target existing owner rows,
  but must not target launcher-only rows.

## Verification Already Completed

Focused tests:

- `bun test test/services/codex-run-observer-service.test.ts` passed.
- `bun test test/tree-view/openclaw-task-nodes.test.ts` passed.
- `bunx tsc --noEmit --pretty false` passed.
- `git diff --check` passed.

Full gate:

- `just ready` passed.
- Result summary: `1460 pass`, `1 skip`, `0 fail`.

Real VS Code Extension Development Host:

- Launched with:
  - `just fixture-edh test/fixtures/agent-status/dogfood-live-tasks.json`
- Verified root Agent Status tree shows:
  - `Codex Runs · 101`
- Verified an expanded row shows:
  - `Status: Failed`
  - `Source status: failed`
  - `Lifecycle owner: launcher:cc-steer-contract-fix (...)`
- This confirms the earlier unsafe `22`-run collapse is fixed and the visible tree details render in
  the compiled extension.

Build:

- `bun run build` passed and installed the production VSIX locally.
- Because the current package version `0.6.0-rc.11` already exists, the build regenerated
  `releases/digest-v0.6.0-rc.11.md`; that generated churn was cleaned back out during this pass.

## Release Integration Steps

1. Review the full diff, not just the summary:

   ```bash
   git diff -- src/services/codex-run-observer-service.ts \
     src/providers/agent-status-tree-provider.ts \
     test/services/codex-run-observer-service.test.ts \
     test/tree-view/openclaw-task-nodes.test.ts \
     research/SPEC-codex-symphony-visibility-layer-2026-04-29.md \
     research/HANDOFF-codex-run-observer-mvp-2026-04-29.md \
     research/HANDOFF-codex-runs-release-integration-2026-04-30.md
   ```

2. Re-run the gate:

   ```bash
   just ready
   ```

3. Dogfood the VS Code-native view again:

   ```bash
   just fixture-edh test/fixtures/agent-status/dogfood-live-tasks.json
   ```

   Inspect Agent Status:

   - `Codex Runs · 101` appears at root.
   - A launcher-only row expands with one launcher lifecycle owner, not a long unrelated merge chain.
   - Detail children include normalized status, raw source status, lifecycle owner, workspace, run id,
     source, last event, and artifacts when available.

4. Cut the next release through the existing repo release path only.

   Use the established preview/release flow rather than custom packaging:

   ```bash
   just cut-preview
   ```

   or, if the maintainer explicitly wants a current-version local install rather than a new preview:

   ```bash
   bun run build
   ```

   Do not manually edit release artifacts except to back out accidental churn when not cutting a
   release. If cutting an actual release, the version bump, VSIX, and digest are expected release
   outputs.

5. Confirm the extension identity and artifact:

   - package id: `oste.command-central`
   - current package version before the next release: `0.6.0-rc.11`
   - expected VSIX pattern: `releases/command-central-<version>.vsix`

## Hub And Node Propagation

Hub:

1. Commit the reviewed implementation and docs on the hub checkout.
2. Record:
   - commit SHA
   - package version
   - VSIX path
   - `just ready` result
   - EDH dogfood result

Node:

1. Discover the node checkout path from the existing OpenClaw/node environment; do not assume a path
   if the node layout has changed.
2. Before updating the node checkout, run:

   ```bash
   git status --short
   git rev-parse HEAD
   ```

   If the node checkout is dirty with unrelated work, stop and report the dirty files before pulling,
   rebasing, or overwriting anything.

3. Bring the node checkout to the exact hub commit using the team's normal non-destructive sync path.
   Prefer fetch/pull/cherry-pick over ad hoc file copying.
4. Verify hub and node match:

   ```bash
   git rev-parse HEAD
   git diff --stat <hub-sha>
   ```

   The node should report the same commit SHA, or an empty diff against the hub release commit if the
   deployment path intentionally uses a detached artifact checkout.

5. Install the release VSIX on the node through VS Code's normal extension install path:

   ```bash
   code --install-extension releases/command-central-<version>.vsix --force
   ```

6. Relaunch or reload VS Code on the node and inspect Agent Status.

Node acceptance checks:

- Command Central loads without activation errors.
- Agent Status shows a root-level `Codex Runs` group when Codex launcher rows exist.
- Project filtering still hides out-of-project Codex runs.
- Expanded Codex rows show status/source/lifecycle owner details.
- No duplicate/collapsed launcher-only run behavior reappears.

## Feedback Round Requested

After complete review and hub/node verification, report back with:

- Final commit SHA and release/VSIX version.
- Hub verification result.
- Node verification result.
- Whether `Codex Runs · 101` still appears for the dogfood fixture.
- Any mismatch between the spec/handoff and the implementation.
- Any UX concerns in the VS Code tree, especially around:
  - root placement of `Codex Runs`
  - detail row labels
  - lifecycle owner wording
  - legacy Background/OpenClaw duplication
  - project filtering behavior
- Whether the next slice should stay on tree ergonomics/provenance, or move to a separate
  acquisition slice such as codex-harness/trajectory/process inputs.

Do not silently fix issues found during review unless they are narrow release blockers. For anything
that smells like scheduler behavior, JSONL parsing, dashboard work, or lifecycle reconciliation,
capture the concern and send it back as feedback for the next round.

