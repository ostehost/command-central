# Command Central rc.22 Main Handoff

Date: 2026-05-09
Status: ready for pull from `main`

## Baseline

- Current release commit: `c2a3ddd chore(prerelease): cut command central rc22`
- Latest pushed line includes post-release verification commits through `5c279a3 docs(research): record rc22 operational dogfood`
- Version: `0.6.0-rc.22`
- VSIX: `releases/command-central-0.6.0-rc.22.vsix`
- SHA256: `28ca4dcff85a6c8d80d8d8e4db16d8704ab2a5739ec2a6331b691b9e4f57b481`

## What Changed

- Command Central now projects a read-only Symphony status surface in Agent Status.
- `Symphony / Workstreams` shows TaskFlow conductor/workstream rows.
- `Symphony / Run Attempts` shows projected execution attempts from OpenClaw, TaskFlow, and launcher truth.
- Run-attempt rows surface source-owned evidence, mode, next step, tracker/workflow context, provenance, and explicit missing tracker context.
- Launcher/source ownership remains authoritative. Command Central does not own scheduler, retry, reconciliation, tracker writes, or Linear polling.
- Node-aware VS Code smoke is guarded so real installed-extension proof runs on the MacBook node rather than from the hub.

## Puller Checklist

After pulling:

1. Run `bun install` if dependencies are not current.
2. Run `just ci` for source-level confidence.
3. For VS Code proof, test the installed VSIX on `Mike MacBook Pro`; do not treat a hub-launched dev-extension smoke as product proof.
4. Use `research/DOGFOOD-command-central-rc22-operational-2026-05-09.md` for the accepted rc.22 dogfood observations and known harness notes.

## Testing Boundaries

- Hub: source checks, artifact checks, `just ci`, prerelease gate.
- MacBook node: real VS Code, installed VSIX, live launcher tasks, Agent Status dogfood.
- Do not add product-code test-mode shortcuts to satisfy the VS Code harness.
- Harness flakes should be fixed in harness code or documented separately unless installed-VSIX proof fails.

## Known Follow-Ups

- No rc.23 is currently recommended.
- Next useful workstream is harness hardening: installed-VSIX Agent Status tree snapshots plus read-only action probes.
- Product work should stay bounded to read-only status-surface behavior unless a real installed rc.22 product bug is found.

## Public Actions

No tag, GitHub release, Marketplace publish, or public announcement is included in this handoff.
