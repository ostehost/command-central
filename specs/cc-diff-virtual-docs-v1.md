ULTRATHINK. Use Claude Opus-level reasoning.

# Spec: Virtual Document Provider for Agent Diff View

## Problem

When a user clicks a file change in the Agent Status sidebar, CC opens a VS Code diff view.
Currently, the diff command writes temporary files to `os.tmpdir()` (`/var/folders/...`) and
passes those file URIs to `vscode.diff`. This causes:

1. **Tab titles show temp paths** like `/var/folders/xq/.../before-package.json` instead of
   meaningful paths like `package.json (abc123 ↔ def456)`.
2. **Breadcrumbs show temp directory structure** instead of the project-relative path.
3. **Temp file leaks** — the `activeDiffTempDirs` cleanup only runs on deactivation, so
   crashed/reloaded sessions accumulate orphaned temp dirs.

## Solution

Replace the temp-file approach with a `TextDocumentContentProvider` registered on a custom
URI scheme (`cc-diff:`). VS Code resolves document content on-demand via the provider,
and the URI encodes enough info to reconstruct the content without disk temp files.

## URI Scheme

```
cc-diff:/{relativePath}?project={projectDir}&ref={gitRef}&taskId={taskId}
```

- `relativePath` — repo-relative path (e.g., `src/extension.ts`). This becomes the
  displayed filename in the tab/breadcrumb.
- `project` — URL-encoded absolute project directory path.
- `ref` — git ref (`abc123`, `HEAD`, or the literal `working-tree` for uncommitted).
- `taskId` — for cache keying and identification.

Examples:
- `cc-diff:/package.json?project=%2FUsers%2Fostemini%2Fprojects%2Fcommand-central&ref=abc123&taskId=cc-task-1`
- `cc-diff:/src/foo.ts?project=...&ref=working-tree&taskId=cc-task-1`

## Implementation

### 1. New file: `src/providers/diff-content-provider.ts`

```typescript
import * as vscode from "vscode";

/**
 * Provides git file content for the cc-diff: URI scheme.
 * Used by the per-file diff command to show clean tab names
 * instead of temp file paths.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "cc-diff";

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const projectDir = params.get("project");
    const ref = params.get("ref");

    if (!projectDir || !ref) return "";

    // uri.path is the relative file path (leading / stripped by URI parsing)
    const relativePath = uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;

    if (ref === "working-tree") {
      return this.readWorkingTree(projectDir, relativePath);
    }

    if (ref === "empty") {
      return "";
    }

    return this.readGitRef(projectDir, ref, relativePath);
  }

  private readGitRef(projectDir: string, ref: string, relativePath: string): string {
    try {
      const { execFileSync } = require("node:child_process");
      const content = execFileSync(
        "git", ["-C", projectDir, "show", `${ref}:${relativePath}`],
        { timeout: 5000 }
      );
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
      if (buf.includes(0x00)) return "<<binary file>>";
      return buf.toString("utf-8");
    } catch {
      return "";
    }
  }

  private readWorkingTree(projectDir: string, relativePath: string): string {
    try {
      const path = require("node:path");
      const fs = require("node:fs");
      const abs = path.join(projectDir, relativePath);
      return fs.readFileSync(abs, "utf-8");
    } catch {
      return "";
    }
  }
}
```

### 2. Register in `src/extension.ts` `activate()`

Near the top of activate, after other provider registrations:

```typescript
import { DiffContentProvider } from "./providers/diff-content-provider";

// In activate():
const diffProvider = new DiffContentProvider();
context.subscriptions.push(
  vscode.workspace.registerTextDocumentContentProvider(DiffContentProvider.scheme, diffProvider)
);
```

### 3. Refactor `commandCentral.openFileDiff` command

Replace the temp-file logic (lines ~2466–2497 in current extension.ts) with URI construction:

```typescript
// Build virtual URIs instead of temp files
const buildDiffUri = (ref: string): vscode.Uri => {
  const params = new URLSearchParams({
    project: projectDir,
    ref,
    taskId: node.taskId ?? "unknown",
  });
  return vscode.Uri.parse(
    `${DiffContentProvider.scheme}:/${relativePath}?${params.toString()}`
  );
};

const beforeUri = buildDiffUri(
  beforeFile.kind === "missing" ? "empty" : beforeRef
);
const afterUri = buildDiffUri(
  afterFile.kind === "missing"
    ? "empty"
    : node.taskStatus === "running"
      ? "working-tree"
      : afterRef
);
```

Keep the binary detection logic (check before building URIs). Keep the diff title format.

### 4. Remove temp file infrastructure

- Remove `const activeDiffTempDirs = new Set<string>()` (line 100)
- Remove the temp dir creation/write block in `openFileDiff` (lines ~2466–2490)
- Remove the cleanup loop in `deactivate()` (lines ~2956–2963)
- Remove the `fs` and `os` imports that were only used for temp files in this command
  (keep them if used elsewhere in the function)

### 5. Handle the `readFileAtRef` consolidation

The current `readFileAtRef` local function (lines ~2421–2436) can stay as the binary/missing
detection pass. We still need it to decide whether to show "binary" or "missing" messages.
But we no longer write content to disk — the provider handles content on-demand.

Flow becomes:
1. `readFileAtRef(beforeRef)` → check kind (binary? missing? text?)
2. Same for afterRef / working tree
3. If binary → open file directly (existing behavior)
4. If both missing → show info message (existing behavior)
5. Otherwise → build virtual URIs → `vscode.diff(beforeUri, afterUri, title)`

## What NOT to change

- The full-task diff via `agentDiffOutputChannel` (Output Channel approach) — leave as-is.
- The `commandCentral.gitSort.openDiff` command — different feature, different flow.
- The diff title string format — keep `${basename} (${beforeRef} ↔ ${afterRef}${changeHint})`.
- Binary file handling — keep the early-return with `openFileIfPresent()`.

## Files to modify

1. **NEW:** `src/providers/diff-content-provider.ts` — the content provider
2. **MODIFY:** `src/extension.ts` — register provider, refactor openFileDiff, remove temp infra

## Files NOT to modify

- `src/providers/agent-status-tree-provider.ts` — don't touch
- `test/` — don't touch existing tests (unless they test the temp-file flow directly)
- `package.json` — no new dependencies needed

## Testing

Add a test file `test/providers/diff-content-provider.test.ts` that verifies:
1. Provider returns empty string for `ref=empty`
2. Provider reads working tree files when `ref=working-tree`
3. Provider calls git show for commit refs
4. Provider returns empty string on git errors (missing file at ref)
5. Provider returns `<<binary file>>` for binary content

Use the project's existing test patterns (look at other test files for mock/setup conventions).

## Expected Result

After this change, clicking a file change in the sidebar opens a diff tab titled:
```
package.json (abc123 ↔ def456)
```
With the tab showing `package.json` in the breadcrumb — NOT `/var/folders/.../before-package.json`.

## Verification

1. Build: `bun run compile` must pass
2. Tests: `bun test` must pass (no regressions)
3. Manual: Click a file change in Agent Status sidebar → verify tab shows clean path
4. Manual: Verify binary files still open directly (not diffed)
5. Manual: Verify "both missing" still shows info message
6. Check: no remaining references to `activeDiffTempDirs` or temp-file diff logic
