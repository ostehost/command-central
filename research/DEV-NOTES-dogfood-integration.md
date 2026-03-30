Implemented the dogfood discovery-noise fix against the live machine shape that was driving the UX failure.

What changed:
- `src/discovery/process-scanner.ts`
  - Added explicit exclusion for notification/helper binaries such as `terminal-notifier`, `osascript`, and `notify-send`.
  - Captured scanner diagnostics so the UI can show retained vs filtered matches.
- `src/discovery/agent-registry.ts`
  - Prunes stale discovered agents by PID liveness even after the original session file was already loaded.
  - Exposes discovery diagnostics for the tree provider.
- `src/providers/agent-status-tree-provider.ts`
  - Added a discovery diagnostics report for operators.
- `src/extension.ts` / `package.json`
  - Added `commandCentral.showDiscoveryDiagnostics` and surfaced it in the Agent Status title actions.

Dogfood fixtures/tests:
- Added `test/fixtures/agent-status/dogfood-live-tasks.json`, generated from the live `~/.config/ghostty-launcher/tasks.json` structure on this machine with user-specific paths rewritten and stream paths detached from live `/tmp` files.
- Added regression coverage for:
  - notification-helper process noise
  - stale PID pruning for discovered/session-file agents
  - 200+ task registry rendering
  - history-cap behavior on the live registry shape
  - diagnostics report content

Validation run:
- `just format` does not exist in this repo; attempted and received `Justfile does not contain recipe 'format'`.
- Ran `just fix`
- Ran `just check`
- Ran `bun test test/commands/extension-commands.test.ts test/discovery/process-scanner.test.ts test/discovery/agent-registry.test.ts test/tree-view/agent-status-tree-provider.test.ts`

Observed caveats:
- The tree-provider tests emit expected local stderr noise from mocked git/tmux lookups against non-existent `/Users/test/...` paths, but the suites pass.
