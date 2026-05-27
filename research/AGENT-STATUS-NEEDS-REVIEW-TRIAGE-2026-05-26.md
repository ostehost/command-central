# Agent Status Needs Review Triage - 2026-05-26

Generated: 2026-05-26 18:32 EDT  
Source: `/Users/ostehost/.config/ghostty-launcher/tasks.json`  
Scope: Command Central VS Code extension `Needs Review` / limbo status bucket

## Summary

The live registry currently shows 117 lanes in `Needs Review` across 61 project directories.

The screenshot count was already slightly stale at review time: `config` moved from 6 to 7 review lanes after `linear-intake-config-20260526-181725` completed and entered `completed_dirty`.

## Classification Rules Used

The extension places terminal lanes in `Needs Review` when one of these is true:

- `status` is `completed_dirty`
- `status` is `completed_stale`
- `status` is `completed` and the declared handoff file is missing
- `status` is `completed` and the pending review receipt path is declared but missing

This draft separates those rows into:

- `Review first`: current, merge-relevant, or actively useful work
- `Remove`: stale registry noise, old proof lanes, temp worktrees, missing handoff artifacts, or superseded smoke/review rows

## Review First

### 1. config - Linear/OpenClaw current stack

Review in this order:

1. `claude-linear-intake-skill-exposure-20260526`
2. `linear-intake-config-20260526-181725`

Rationale: the first lane exposes the Linear intake skill to Claude Code; the second depends on that capability and produced the current Linear import dry-run/result artifacts. These are today-owned and on the active `config` main stack.

### 2. command-central - extension lifecycle and release stack

Review in this order:

1. `cc-dogfood-reaper-false-fail-20260525-2138`
2. `cc-prev-chats-completion-20260525-2055`
3. `cc-local-preview-update-routing-20260525-2140`
4. `cc-release-preview-update-20260525-2036`
5. `cc-dogfood-agent-status-20260525-2008`

Rationale: these touch the Agent Status lifecycle UI, completion routing, local preview/release flow, and model alias visibility. They are current extension work and should be reviewed before older Symphony proof rows.

### 3. Ghostty Launcher - cleanup/reaper/watchdog stack

Review in this order:

1. `ghl-child-cleanup-20260525-2140`
2. `ghl-pgid-cleanup-computer-use-20260526-0838`
3. `ghl-watchdog-best-practices-20260525-2101`

Rationale: these are the current launcher cleanup/reaper/computer-use lanes. The PGID lane appears to be partly blocked/proof-oriented, so it may close quickly after checking the handoff.

### 4. symphony-openclaw-spike - Day 3 cleanup stack

Review as one stack:

1. `symphony-linear-day3-cleanup-fixup-20260526`
2. `symphony-linear-metadata-fix-20260526`
3. `symphony-linear-final-head-receipt-fix-20260526`

Rationale: all three touch the same Day 3 cleanup/handoff metadata chain. Review together to avoid re-litigating the same artifact corrections three times.

## Remove From The List

Remove or dismiss every lane not listed in `Review First`, unless a reviewer explicitly needs historical audit context.

The rows recommended for removal are mostly one of:

- old `/tmp` or `/private/tmp` proof/review worktrees
- missing handoff files for already-superseded work
- missing pending review receipt files for old completed lanes
- `completed_stale` rows from April or early May
- historical smoke/proof lanes that have been overtaken by current commits

High-volume remove groups:

- `command-central`: remove 22 of 27 lanes, keeping only the 5 current review-first lanes
- `Ghostty Launcher`: remove 14 of 17 lanes, keeping only the 3 current review-first lanes
- `config`: remove 5 of 7 lanes, keeping only the 2 current Linear/OpenClaw lanes
- all remaining one-off temp projects: remove entirely

## Complete Current Inventory

### config

Directory: `/Users/ostehost/projects/config`

Review first:

- `claude-linear-intake-skill-exposure-20260526`
- `linear-intake-config-20260526-181725`

Remove:

- `linear-board-review-node-20260516`
- `autoproc-birdclaw-json-parse-20260511-2158`
- `autoproc-config-skill-validator-20260511-2158`
- `cron-alert-routing-20260505`
- `config-watchdog-guard-smoke-20260422-1638`

### symphony-openclaw-spike

Directory: `/Users/ostehost/projects/symphony-openclaw-spike`

Review first:

- `symphony-linear-final-head-receipt-fix-20260526`
- `symphony-linear-metadata-fix-20260526`
- `symphony-linear-day3-cleanup-fixup-20260526`

Remove:

- None

### Ghostty Launcher

Directory: `/Users/ostehost/projects/ghostty-launcher`

Review first:

- `ghl-pgid-cleanup-computer-use-20260526-0838`
- `ghl-child-cleanup-20260525-2140`
- `ghl-watchdog-best-practices-20260525-2101`

Remove:

- `autoproc-ghl-raw-refusal-20260511-2158`
- `gl-agent-mode-provenance-20260509-1915`
- `gl-review-queue-contract-20260509-1655`
- `cc-symphony-node-vscode-proof-20260508-2048`
- `ghl-lifecycle-cleanup-proof-20260508-2128`
- `ghl-completion-process-tree-20260508-2109`
- `cc-symphony-node-showcase-20260508-1845`
- `showcase-node-visible-retry-20260508-1548`
- `showcase-node-visible-final-20260508-1548`
- `showcase-node-visible-20260508-1539`
- `ghl-owner-routing-visible-smoke-20260429-1920`
- `ghl-host-routing-audit-watchdog-20260425-1925`
- `stop-hook-pending-review-analysis-20260425`
- `native-completion-dogfood-20260425`

### command-central

Directory: `/Users/ostehost/projects/command-central`

Review first:

- `cc-local-preview-update-routing-20260525-2140`
- `cc-dogfood-reaper-false-fail-20260525-2138`
- `cc-prev-chats-completion-20260525-2055`
- `cc-release-preview-update-20260525-2036`
- `cc-dogfood-agent-status-20260525-2008`

Remove:

- `autoproc-cc-snapshot-refactor-20260511-2158`
- `cc-symphony-dogfood-workstreams-impl-20260510-0955`
- `cc-rc23-installed-vsix-live-20260509-2235`
- `cc-installed-vsix-proof-live9-20260509-2122`
- `cc-rc23-decision-review-20260509-2113`
- `cc-installed-vsix-proof-live8-20260509-2110`
- `cc-installed-vsix-proof-live7-20260509-2045`
- `cc-installed-vsix-proof-live6-20260509-2043`
- `cc-artifact-identity-review-20260509-2036`
- `cc-installed-vsix-proof-live5-20260509-2020`
- `cc-installed-vsix-proof-live4-20260509-2015`
- `cc-installed-vsix-proof-live3-20260509-2011`
- `cc-installed-vsix-proof-live2-20260509-2004`
- `cc-installed-vsix-proof-live-20260509-1958`
- `cc-symphony-queue-gap-ui-20260509-1655`
- `cc-rc22-operational-dogfood-focus-20260509-1640`
- `cc-rc22-operational-dogfood-20260509-1637`
- `cc-symphony-dogfood-team-20260509-1229`
- `cc-symphony-claude-launcher-runs-small-20260508-2210`
- `cc-node-dirty-inventory-20260429`
- `cc-install-prerelease`
- `cc-telemetry-m35-7`

### Ghostty Launcher sync review 20260421

Directory: `/Users/ostehost/projects/ghostty-launcher-sync-review-20260421`

Remove:

- `ghl-reuse-proof-c-20260421-1740`
- `ghl-reuse-proof-b-20260421-1738`
- `ghl-reuse-proof-a-20260421-1320`

### Command Central sync review 20260421

Directory: `/Users/ostehost/projects/command-central-sync-review-20260421`

Remove:

- `cc-visible-retry2-20260421-1310`
- `cc-visible-retry-20260421-1243`
- `cc-sync-start-20260421-1154`

### concierge-concierge-poc-intake-viewer-20260419-1440-review

Directory: `/tmp/concierge-concierge-poc-intake-viewer-20260419-1440-review`

Remove:

- `review-concierge-poc-intake-viewer-20260419-1440`

### concierge-concierge-poc-presentation-readiness-20260419-1343-review

Directory: `/tmp/concierge-concierge-poc-presentation-readiness-20260419-1343-review`

Remove:

- `review-concierge-poc-presentation-readiness-20260419-1343`

### concierge-concierge-node-artifact-index-20260419-0948-rerun-review

Directory: `/tmp/concierge-concierge-node-artifact-index-20260419-0948-rerun-review`

Remove:

- `review-concierge-node-artifact-index-20260419-0948-rerun`

### concierge-concierge-node-artifact-index-20260419-0948-review

Directory: `/tmp/concierge-concierge-node-artifact-index-20260419-0948-review`

Remove:

- `review-concierge-node-artifact-index-20260419-0948`

### concierge-concierge-autonomous-loop-dogfood-20260419-0911-review

Directory: `/tmp/concierge-concierge-autonomous-loop-dogfood-20260419-0911-review`

Remove:

- `review-concierge-autonomous-loop-dogfood-20260419-0911`

### concierge-concierge-cockpit-launcher-smoke-rerun7-20260418-1545-review

Directory: `/tmp/concierge-concierge-cockpit-launcher-smoke-rerun7-20260418-1545-review`

Remove:

- `review-concierge-cockpit-launcher-smoke-rerun7-20260418-1545`

### concierge-concierge-cockpit-launcher-smoke-rerun6-20260418-1523-review

Directory: `/tmp/concierge-concierge-cockpit-launcher-smoke-rerun6-20260418-1523-review`

Remove:

- `review-concierge-cockpit-launcher-smoke-rerun6-20260418-1523`

### concierge-concierge-cockpit-launcher-smoke-rerun5-20260418-1517-review

Directory: `/tmp/concierge-concierge-cockpit-launcher-smoke-rerun5-20260418-1517-review`

Remove:

- `review-concierge-cockpit-launcher-smoke-rerun5-20260418-1517`

### concierge-concierge-cockpit-launcher-smoke-rerun3-20260418-1458-review

Directory: `/tmp/concierge-concierge-cockpit-launcher-smoke-rerun3-20260418-1458-review`

Remove:

- `review-concierge-cockpit-launcher-smoke-rerun3-20260418-1458`

### concierge-concierge-cockpit-launcher-smoke-20260418-1308-review

Directory: `/tmp/concierge-concierge-cockpit-launcher-smoke-20260418-1308-review`

Remove:

- `review-concierge-cockpit-launcher-smoke-20260418-1308`

### concierge-concierge-cockpit-launcher-smoke-rerun4-20260418-1503-review

Directory: `/tmp/concierge-concierge-cockpit-launcher-smoke-rerun4-20260418-1503-review`

Remove:

- `review-concierge-cockpit-launcher-smoke-rerun4-20260418-1503`

### concierge-concierge-cockpit-launcher-smoke-rerun2-20260418-1448-review

Directory: `/tmp/concierge-concierge-cockpit-launcher-smoke-rerun2-20260418-1448-review`

Remove:

- `review-concierge-cockpit-launcher-smoke-rerun2-20260418-1448`

### cc-promote-multi-stream-0415

Directory: `/private/tmp/cc-promote-multi-stream-0415`

Remove:

- `cc-promote-multi-stream-0415`

### ghl-spoke-relay-zellij-0415

Directory: `/private/tmp/ghl-spoke-relay-zellij-0415`

Remove:

- `ghl-spoke-relay-zellij-0415`

### ghl-visible-session-cleanup-0415

Directory: `/private/tmp/ghl-visible-session-cleanup-0415`

Remove:

- `ghl-visible-session-cleanup-0415`

### Ghostty Launcher

Directory: `/private/tmp/ghl-multi-terminal-dogfood-0415`

Remove:

- `ghl-multi-terminal-dogfood-0415`

### cc-multi-stream-ux-0415

Directory: `/private/tmp/cc-multi-stream-ux-0415`

Remove:

- `cc-multi-stream-ux-spec-0415`

### ghostty-launcher-autoloop-concurrency-0415

Directory: `/Users/ostehost/projects/ghostty-launcher-autoloop-concurrency-0415`

Remove:

- `ghl-review-autoloop-concurrency-0415a`

### ghostty-launcher-spawn-truth-0415

Directory: `/Users/ostehost/projects/ghostty-launcher-spawn-truth-0415`

Remove:

- `ghl-spawn-truth-0415b`

### concierge

Directory: `/Users/ostehost/projects/concierge`

Remove:

- `remote-node-concierge-smoke-130945`

### ghostty-launcher-integration-0412-185511

Directory: `/Users/ostehost/projects/ghostty-launcher-integration-0412-185511`

Remove:

- `ghl-integrate-node-branches-0412`

### ghl-spawn-timeout-hygiene-v1 0410-202546

Directory: `/Users/ostehost/projects/ghl-spawn-timeout-hygiene-0410-202546`

Remove:

- `ghl-spawn-timeout-hygiene-v1`

### Ghostty Launcher Just Check Opt

Directory: `/tmp/ghostty-launcher-justcheck-opt-1775759307`

Remove:

- `justcheck-opt-v1`

### Ghostty Launcher Node Remote Spawn 0410 143156

Directory: `/Users/ostehost/projects/ghostty-launcher-node-remote-spawn-0410-143156`

Remove:

- `ghl-node-remote-spawn-team-v1`

### Ghostty Launcher Node Sync 0412

Directory: `/Users/ostehost/projects/ghostty-launcher-node-sync-0412`

Remove:

- `node-first-visible-routing-0412`

### Ghostty Launcher Prompt Fix 0410-150815

Directory: `/Users/ostehost/projects/ghostty-launcher-prompt-fix-0410-150815`

Remove:

- `ghl-prompt-fix-v1`

### command-central-helper-anchor.Jtw5JZ

Directory: `/private/tmp/command-central-helper-anchor.Jtw5JZ`

Remove:

- `cc-fix-helper-anchor-v2`

### command-central-health-tree.K8ZE5a

Directory: `/private/tmp/command-central-health-tree.K8ZE5a`

Remove:

- `cc-health-tree-slice1-v1`

### Ghostty Launcher remote spawn main

Directory: `/private/tmp/ghostty-launcher-remote-spawn-main.MPLGQr`

Remove:

- `ghl-fix-remote-spawn-main-v1`

### Ghostty Launcher remote migrate

Directory: `/private/tmp/ghostty-launcher-remote-migrate.eGLs8w`

Remove:

- `ghl-migrate-remote-status-capture-v1`

### Ghostty Launcher remote node spec

Directory: `/private/tmp/ghostty-launcher-remote-node-spec.2wDIdn`

Remove:

- `ghl-remote-node-exec-spec-v2`

### command-central-monitoring-spec.2eJnB8

Directory: `/private/tmp/command-central-monitoring-spec.2eJnB8`

Remove:

- `cc-monitoring-phase2-spec-v2`

### Ghostty Launcher

Directory: `/private/tmp/ghostty-launcher-visible-ux-macbook.yXRAXd`

Remove:

- `polish-visible-lane-ux-macbook-v8`

### Ghostty Launcher

Directory: `/private/tmp/ghostty-launcher-visible-ux-macbook.3VZqnO`

Remove:

- `polish-visible-lane-ux-macbook-v7`

### notify-hub-remote-dogfood-1775790700

Directory: `/private/tmp/notify-hub-remote-dogfood-1775790700`

Remove:

- `notify-hub-remote-dogfood-v1`

### notify-remote-dogfood-verify-1775790478

Directory: `/private/tmp/notify-remote-dogfood-verify-1775790478`

Remove:

- `notify-remote-dogfood-verify-v1`

### Notify Dogfood Verify

Directory: `/private/tmp/notify-dogfood-spoke-verify-1775788041`

Remove:

- `notify-dogfood-verify-v1`

### Notify Dogfood Spoke

Directory: `/private/tmp/notify-dogfood-spoke-1775782662`

Remove:

- `notify-dogfood-spoke-v1`

### Ghostty Launcher Test Bottlenecks

Directory: `/tmp/ghostty-launcher-test-bottlenecks-1775758067`

Remove:

- `test-bottlenecks-v1d`

### ghostty-launcher-zellij-single-launcher-dev-tmux-1775757463

Directory: `/tmp/ghostty-launcher-zellij-single-launcher-dev-tmux-1775757463`

Remove:

- `zellij-single-launcher-dev-v1`

### ghostty-launcher-zellij-single-launcher-review-tmux-1775757463

Directory: `/tmp/ghostty-launcher-zellij-single-launcher-review-tmux-1775757463`

Remove:

- `zellij-single-launcher-review-v1`

### ghostty-launcher-zellij-single-launcher-spec-tmux-1775757463

Directory: `/tmp/ghostty-launcher-zellij-single-launcher-spec-tmux-1775757463`

Remove:

- `zellij-single-launcher-spec-v1`

### Ghostty Launcher

Directory: `/tmp/ghostty-launcher-justcheck-hash-1775752720`

Remove:

- `justcheck-cleanup-v2`
- `justcheck-hashfile-v1`

### Ghostty Launcher

Directory: `/tmp/ghostty-launcher-prompt-visible-1775756085`

Remove:

- `prompt-visibility-v1`

### Ghostty Launcher

Directory: `/tmp/ghostty-launcher-zellij-ready-1775754553`

Remove:

- `zellij-readiness-v1`

### Ghostty Launcher

Directory: `/tmp/ghostty-launcher-macbook-routing-1775744488`

Remove:

- `macbook-routing-receipts-v1`
- `macbook-visible-routing-spec-v2`

### ghl-zellij-pr3.ucRPnD

Directory: `/tmp/ghl-zellij-pr3.ucRPnD`

Remove:

- `zellij-pr3-terminal-backend`

### ghl-zellij-audit.satuCP

Directory: `/tmp/ghl-zellij-audit.satuCP`

Remove:

- `zellij-runtime-audit`

### ghl-zellij-spec.Ifr2p8

Directory: `/tmp/ghl-zellij-spec.Ifr2p8`

Remove:

- `zellij-pr4-pr5-spec`

### obr-125512

Directory: `/tmp/obr-125512`

Remove:

- `obr-125512`

### gzi-120855

Directory: `/tmp/gzi-120855`

Remove:

- `gzi-120855`

### gzr-120402

Directory: `/tmp/gzr-120402`

Remove:

- `gzr-120402`

### Ghostty Zellij MacBook Live Review 20260408-120106

Directory: `/tmp/ghostty-zellij-macbook-live-review-20260408-120106`

Remove:

- `review-zellij-macbook-live-20260408-120106`

### Ghostty Zellij MacBook Live 20260408-103921

Directory: `/tmp/ghostty-zellij-macbook-live-20260408-103921`

Remove:

- `zellij-macbook-live-20260408-103921`

### Ghostty Zellij Cross Host Plan 20260408-093724

Directory: `/tmp/ghostty-zellij-plan-20260408-093724`

Remove:

- `zellij-cross-host-plan-20260408-093724-visible`

## Draft Review Notes

Recommended operator flow:

1. Review and close the 15 `Review first` lanes.
2. Remove all `completed_stale` lanes older than 7 days.
3. Remove all rows whose project directory is under `/tmp` or `/private/tmp`.
4. Remove completed rows whose only review reason is a missing handoff or pending-review receipt from superseded proof lanes.
5. Re-run Agent Status refresh and confirm `Needs Review` drops to the current active stacks only.

Open question for follow-up: whether Command Central should offer a bulk action for `Needs Review` rows whose project directory is temp-owned and whose completion timestamp is older than a configurable threshold.
