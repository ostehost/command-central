# Contract Decision: Tasks File Resolver Precedence

Classification: contract decision required (ratified same-day)

## Decision Surface

Command Central currently disagrees about where the launcher task registry should
be discovered when the user has not configured an explicit path.

## Conflicting Sources

### Position A: README intent

- `README.md:93` says `${workspaceFolder}/.ghostty-launcher/tasks.json` is the
  first-priority location.

### Position B: resolver implementation

- `src/utils/tasks-file-resolver.ts:14` only checks XDG and legacy global
  locations.

### Position C: unit test contract

- `test/utils/tasks-file-resolver.test.ts:86` explicitly asserts that a global
  path wins over a workspace-local path.

## Resolution Options

1. Code wins
   Update README and keep global-only auto-detection.

2. README wins
   Update resolver and tests so workspace-local discovery beats global files.

3. Hybrid with multi-root precision
   Preserve config-first behavior, then honor workspace-local files before
   global files, with deterministic multi-root ordering.

4. Redesign
   Replace path-order precedence with a new discovery UX or prompt-based model.

## Recommendation

Adopt the hybrid-with-multi-root resolution:

1. Configured path
2. Workspace-local tasks file
3. XDG global
4. Legacy global

Multi-root workspaces resolve workspace-local files in
`vscode.workspace.workspaceFolders` order. The first existing
`${workspaceFolder}/.ghostty-launcher/tasks.json` wins within that tier before
falling through to global locations.

## Ratified

Date: 2026-04-22
Ratifier: @ostehost

Resolution:

1. Configured path (explicit setting)
2. Workspace-local tasks file
3. XDG global
4. Legacy global (`~/.ghostty-launcher/tasks.json`)

Multi-root workspaces: resolve workspace-local files in VS Code
workspace-folder order; first existing wins.

Rationale:

- Matches the long-documented README intent.
- Makes workspace-local registries the first-priority user-visible behavior
  after an explicit configured override.
- Keeps non-workspace contexts simple by skipping the workspace-local tier when
  no workspace folders are available.

## Stop Condition

Ratification is complete. Implementation proceeds in subsequent commits on the
same branch.
