# DEV NOTES: Agent Status Scope Toggle

## Scope shipped

Implemented the Agent Status scope toggle so the tree can switch between the default global control-tower view and a workspace-scoped view.

- Added `commandCentral.agentStatus.scope` with enum values `"all"` and `"currentProject"`, defaulting to `"all"`.
- Added paired toolbar toggle actions in Agent Status so the title bar cycles between `All Agents` and `Current Project`.
- Persisted scope changes at `ConfigurationTarget.Workspace`, so the toggle is sticky per workspace.
- Filtered Agent Status root content to the active workspace folders when `currentProject` is enabled.
- Added scope-aware summary text such as `All · 5 agents ...` or `<workspace> · 2 agents ...`.
- Added empty-state messaging for scoped mode when there are tracked agents globally but none in the current workspace.
- Kept the existing global default unchanged.

## Files changed

- `src/providers/agent-status-tree-provider.ts`
- `src/extension.ts`
- `package.json`
- `test/tree-view/agent-status-tree-provider.test.ts`
- `test/commands/extension-commands.test.ts`
- `test/package-json/agent-menu-contributions.test.ts`
- `test/helpers/vscode-mock.ts`

## Tests updated

- Provider tests now cover current-project filtering and scope-aware summary/empty states.
- Command tests now cover workspace-sticky scope toggles.
- Package contribution tests now cover the new config key and toolbar button state.

## Verification

- `bun test test/commands/extension-commands.test.ts test/tree-view/agent-status-tree-provider.test.ts test/package-json/agent-menu-contributions.test.ts`
- `bunx tsc --noEmit`
- `just test`

Result: all passed in this workspace.

## Validation note

The task prompt required `just format`, but this repo does not define that recipe. Running `just format` fails with:

- `Justfile does not contain recipe 'format'`

Used `just fix` instead, which is the repo’s actual format/lint autofix entrypoint.
