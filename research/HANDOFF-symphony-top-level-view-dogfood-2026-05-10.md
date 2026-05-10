# Handoff: Symphony Top-Level View Dogfood

Date: 2026-05-10
Base commit: `f5b8d34`
Working slice: promote Symphony from an Agent Status root into its own top-level Command Central tree view.

## Product Result

Command Central now contributes a sibling top-level VS Code tree view:

- `commandCentral.symphony` / `Symphony`
- `commandCentral.agentStatus` / `Agent Status`

`Symphony` is still a read-only Status Surface. It reuses the existing source-owned projections and renders:

- `Operations Dashboard`
- `Running Sessions`
- `Retry Queue`
- `Workstreams`
- `Run Attempts`

`Agent Status` no longer contains the full Symphony tree. It keeps only a lightweight `Symphony Status Surface: ...` summary row so operators are directed to the top-level Symphony view without duplicate nested content.

Boundary preserved:

- no scheduler ownership
- no tracker polling or writes
- no retry/cancel/claim controls
- no drag/drop
- no workspace management
- no lifecycle mutation

## Proof Receipts

Hub validation:

- `bun test test/integration/installed-vsix-proof-harness.test.ts test/package-json/manifest-contract.test.ts test/tree-view/openclaw-task-nodes.test.ts` -> `47 pass / 0 fail`
- `bunx tsc --noEmit --pretty false` -> pass
- `git diff --check` -> pass
- `just check` -> pass
- `just ci` -> `1540 pass / 8 skip / 0 fail`

MacBook node validation:

- Staged repo: `/Users/ostehost/projects/command-central-symphony-top-view`
- VSIX: `/tmp/command-central-symphony-top-view.vsix`
- VSIX SHA256: `2723ad98fcf053f40f6a91e2971a918e8a5d3e5e31829ca0e6a68ccf2b3a839f`
- Normal profile consumption receipt: `/tmp/command-central-symphony-consumption.json`
- Installed proof manifest: `/tmp/command-central-symphony-top-view-proof.json`
- Focused node tests: `47 pass / 0 fail`
- Node typecheck and `git diff --check`: pass

Installed proof result:

- version: `0.6.0-rc.25`
- VSIX SHA matched: `2723ad98fcf053f40f6a91e2971a918e8a5d3e5e31829ca0e6a68ccf2b3a839f`
- errors: `[]`
- manifest sibling views: `commandCentral.symphony` and `commandCentral.agentStatus`
- Symphony view roots: `Operations Dashboard`, `Running Sessions · 0`, `Retry Queue · 0`, `Workstreams · 0`, `Run Attempts · 35`
- Agent Status roots began with `Symphony Status Surface: 35 run attempts · 0 workstreams`, then normal project groups

## Delegation Dogfood Result

Visible implementation lane attempted:

- task id: `cc-symphony-top-view-20260510-1245c`
- staged repo: `/Users/ostehost/projects/command-central-symphony-top-view`
- session: `agent-command-central-symphony-top-view`
- result: killed after it became stuck and produced no edits

Because the implementation lane did not produce code, the lead landed the patch directly on hub and used the MacBook staged repo for proof. That is the correct product outcome, but not a successful implementation-delegation outcome.

## Process Hardening Findings

The delegation path exposed several process gaps:

- Hub-visible spawn was correctly blocked; visible Ghostty launcher lanes are node-only.
- The MacBook canonical checkout was stale/dirty, so a staged clone under `~/projects` was required.
- Launcher validation rejected a temp clone outside `~/projects`.
- The staged clone needed an origin URL whose repo basename matched the checkout directory before launcher validation accepted it.
- OpenClaw agent sandbox `HOME` broke remote launcher preflight until commands were run with `HOME=/Users/ostemini`.
- Missing owner routing required `--allow-detached-visible`; completion could not wake the current WebChat run directly.
- The Claude lane was marked `running` before it cleared the workspace trust prompt.
- `oste-steer.sh --by-task-id` interrupted the lane and left it at a "What should Claude do instead?" prompt.
- Manual tmux steering was brittle and got stuck in the multi-line composer.
- The lane consumed steering but stayed in analysis and never edited files.

Recommended follow-up hardening:

- Add a launcher preflight mode that validates node checkout cleanliness, origin basename, trust state, and owner routing before spawning.
- Make visible lane status distinguish `waiting_for_trust`, `awaiting_prompt`, `running_model`, and `editing`.
- Add a non-interrupting steering path for visible Claude lanes, or make `oste-steer.sh` detect and recover from the interruption prompt.
- Provide a first-class "stage hub patch on node and run proof" helper for product slices that need real VS Code evidence.
- Store proof manifests outside `/tmp` when they are release or acceptance receipts.
