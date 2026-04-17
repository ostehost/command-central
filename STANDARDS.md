# Engineering Standards

## Test suite value hierarchy

The test suite should maximize developer confidence per unit of time.

Use this validation ladder in order:

1. Run the smallest reproducer for the code you touched.
2. Run the nearest slice, usually a file, directory, or paired interaction.
3. Run `just test` before asking others to trust a broad change.
4. Run coverage separately when needed, not as the default local feedback loop.

### Fast validation commands

```bash
# Critical Bun leakage reproducer for discovery + commands
bun test --max-concurrency=1 \
  test/discovery/agent-registry.test.ts \
  test/commands/three-way-diff-command.test.ts \
  test/commands/resume-session.test.ts

# Main local confidence check
just test
```

If the 3-file reproducer is slow again, assume a subprocess or global mock leak first.

## Bun-specific rules

Bun test files currently share one process and `mock.module()` is global. `mock.restore()` does not undo module mocks. Write tests and production code accordingly.

### 1) Never use module-scope `promisify(execFile)` or `promisify(exec)`

Bad:

```ts
const execFileAsync = promisify(execFile);
```

Why this is banned:
- it snapshots the real child-process function at module load time
- later `mock.module("node:child_process", ...)` calls do not affect it
- tests then spawn real subprocesses unexpectedly
- real subprocess handles can poison later tests and destroy suite speed

Required pattern:

```ts
function execFileAsync(
  file: string,
  args: ReadonlyArray<string>,
  options: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args as string[], options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
```

Resolve `execFile` through its ES live binding on every call.

### 2) Never use `import * as realX from "node:Y"` in test files to preserve the real module

Bad:

```ts
import * as realFs from "node:fs";
mock.module("node:fs", () => ({ ...realFs }));
```

Why this is banned:
- Bun namespace imports are live
- later module mocks mutate what the namespace points to
- spreading that namespace can re-spread a mocked module back into another mock

Required pattern:
- preload stores frozen snapshots on `globalThis.__realNode*`
- tests read those snapshots instead of importing the live namespace

Example:

```ts
const realFs = (globalThis as Record<string, unknown>)["__realNodeFs"] as typeof import("node:fs");
```

### 3) Every `start()` in tests must pair with `dispose()`

If a test starts watchers, pollers, subscriptions, or background scans, it must dispose them in `afterEach` or in the test itself.

Required outcomes:
- no leaking `setInterval`
- no leaking `fs.watch`
- no leaking VS Code disposables
- no callbacks from prior tests firing during later tests

### 4) Prefer pass-through mocks over total replacement for core modules

When mocking `node:fs` or `node:child_process`, intercept only the calls the test owns and pass everything else through to the real implementation.

This prevents unrelated tests from accidentally inheriting a crippled mock.

### 5) Avoid file-scope mocks that leave required exports undefined

If a file replaces a whole module, it must preserve the exports the module's consumers may call. Silent omissions create future-order flakes.

### 6) Fire change events only on meaningful state changes

Polling code should diff against previous state before firing tree refresh or change events. Re-render churn creates noise, hides real regressions, and lowers the signal value of tests.

## Portability rules for tests

### 7) Never hardcode a specific home directory in tests

Bad:

```ts
"/Users/ostemini/..."
```

Required pattern:

```ts
path.join(os.homedir(), ...)
```

Tests must pass on `ostemini`, `ostehost`, CI, and any future machine.

## What to check first when the suite gets slow

1. Search for module-scope `promisify(execFile)` or `promisify(exec)`.
2. Search for module-scope `mock.module("node:child_process"` and `mock.module("node:fs"`.
3. Search for live namespace preservation patterns like `import * as realFs`.
4. Search for tests that call `start()` without guaranteed disposal.
5. Re-run the 3-file reproducer before profiling the whole suite.

## Current known high-value repro

This interaction caught the leak that made the suite catastrophically slow on node:

```bash
bun test --max-concurrency=1 \
  test/discovery/agent-registry.test.ts \
  test/commands/three-way-diff-command.test.ts \
  test/commands/resume-session.test.ts
```

If this command is fast and green, the most dangerous Bun child-process leakage class is probably not present.
