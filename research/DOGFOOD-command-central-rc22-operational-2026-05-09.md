# Command Central rc.22 Operational Dogfood

Date: 2026-05-09
Status: accepted for internal dogfood

## Release Verified

- Version: `0.6.0-rc.22`
- Release commit: `c2a3ddd chore(prerelease): cut command central rc22`
- Current hub source: `eb71956 test(release): guard vscode smoke to node` includes `c2a3ddd`
- VSIX: `/Users/ostemini/projects/command-central/releases/command-central-0.6.0-rc.22.vsix`
- SHA256: `28ca4dcff85a6c8d80d8d8e4db16d8704ab2a5739ec2a6331b691b9e4f57b481`

## Machines Used

- Hub `/Users/ostemini/projects/command-central`: source/artifact checks only.
- MacBook node `/Users/ostehost`: installed VSIX, real VS Code, launcher tasks, and read-only action proof.

## Live Dogfood Lanes

Two bounded node launcher lanes were created only to give rc.22 real launcher truth to observe. Both wrote handoff artifacts under `/tmp` only and made no repository edits.

- `cc-rc22-operational-dogfood-20260509-1637`
  - Status: `completed`
  - Purpose: prove installed rc.22 observed task count rising while a live launcher row existed.
  - Evidence: installed smoke loaded `293` launcher tasks and exited 0.
  - Handoff: `/tmp/cc-rc22-operational-dogfood-20260509-1637-handoff.md`

- `cc-rc22-operational-dogfood-focus-20260509-1640`
  - Status: `completed`, exit `0`
  - Purpose: hold a live row long enough to exercise safe read-only actions.
  - Handoff: `/tmp/cc-rc22-operational-dogfood-focus-20260509-1640-handoff.md`

## Installed UI / Read Model Observations

The installed rc.22 extension on the MacBook node activated successfully and loaded the real launcher registry at `/Users/ostehost/.config/ghostty-launcher/tasks.json`.

- Baseline accepted smoke: `installed-smoke-ok version=0.6.0-rc.22 rootChildren=126 tasks=292`
- First live marker smoke: `installed-smoke-ok version=0.6.0-rc.22 rootChildren=126 tasks=293`
- Read-only action smoke during live focus marker: `readonly-actions-ok version=0.6.0-rc.22 rootChildren=126 tasks=294`

Installed bundle/read-model checks confirmed the rc.22 MVP surface includes:

- `Symphony / Workstreams`
- `Symphony / Run Attempts`
- Evidence rows with open/copy commands
- `Mode` and `Next step`
- `Automation source`, `Tracker source`, and `Workflow contract`
- Explicit missing tracker context: `Not provided by lifecycle owner`
- Read-only lifecycle language: `read-only projected` and `Lifecycle ownership stays with the source owner`
- Provenance rows: `Provenance from ...`

Real launcher truth for the live focus marker exposed the operator fields needed by the UI:

- lifecycle owner: launcher-owned row
- task state: `running`, later `completed`
- evidence/artifacts: `prompt_file`, `handoff_file`, `pending_review_path`, `pending_fixup_path`
- mode/context: `role=reviewer`, `model=claude-opus-4-7`, `exec_mode=spoke`, `exec_node=Mike's MacBook Pro`, `exec_host=Mike's MacBook Pro`
- terminal focus identity: `session_id=agent-command-central`, `tmux_window_id=@7`, `tmux_pane_id=%11`
- tracker context: not provided by lifecycle owner, which rc.22 surfaces explicitly rather than silently omitting

## Safe Read-Only Actions Exercised

Against installed rc.22 while `cc-rc22-operational-dogfood-focus-20260509-1640` was running:

- refreshed Agent Status
- copied the launcher task ID via `commandCentral.copyToClipboard`
- opened the prompt evidence file via `vscode.open`
- focused the live terminal via `commandCentral.focusAgentTerminal`

No cancel, retry, fixup, tracker write, scheduler, reconciliation, or lifecycle mutation path was exercised.

## What Worked

- rc.22 was useful for live monitoring: the real node registry task count changed from `292` to `293`/`294` as marker lanes launched.
- The UI/read model had enough fields to answer: what run exists, who owns lifecycle state, what evidence exists, which host/node is involved, what mode/model/role is present, and what tracker context is missing.
- Focus terminal worked for the live tmux-backed launcher row.
- Evidence opening and ID copy worked as read-only actions.
- The extension kept Command Central's boundary clear: projected status surface only, no Linear polling or scheduler ownership.

## What Was Confusing

- The installed smoke API exposes root/task counts but not a structured tree snapshot. That forced verification of detailed labels through installed bundle/read-model inspection instead of a first-class installed UI snapshot.
- VS Code reported the extension host as temporarily unresponsive during activation and again during terminal focus, then recovered and exited 0. This is not a product failure, but it makes dogfood logs noisy and lowers confidence in the harness.
- The live marker lane reused `session_id=agent-command-central`. That is launcher/session identity debt, not a Command Central rc.22 product bug, but it makes multiple lanes harder to distinguish.
- `show raw/details` is clear for OpenClaw task rows, but there is no equally obvious raw-source view for launcher/Symphony run-attempt rows in the installed proof path.

## Product Bugs

No rc.22 product bug was found that justifies rc.23.

## Harness-Only Issues

- Running the temp installed-smoke script with `node` failed to resolve `@vscode/test-electron`; running the same script with `bun` from the repo worked.
- Temporary extension-host unresponsive/responsive messages occurred during installed VS Code smokes, but the installed extension activated, rendered, performed actions, and exited 0.
- The first dogfood marker completed too quickly for terminal-focus action testing. The second marker fixed this by staying live long enough for installed rc.22 to focus it.

## Decision

Do not cut rc.23 right now.

The findings are dogfood/harness/process polish, not an installed rc.22 product blocker. Minimum rc.23 patch scope is empty unless a future installed-VSIX dogfood run exposes a real product bug or a packaged harness change becomes necessary for release confidence.

## Smallest Justified Next Work Item

Next non-release workstream: harness hardening.

Minimum scope:

- Add an installed-VSIX dogfood harness that emits a structured Agent Status tree snapshot from the installed extension, not just root/task counts.
- Include read-only action probes for copy ID, open evidence, and focus terminal.
- Keep it node-only through OpenClaw native routing and never use hub-launched dev-extension smoke as product proof.

This is better than adding more Symphony UI now because rc.22 already has enough status-surface value to dogfood, while the proof path still lacks precise installed UI evidence.
