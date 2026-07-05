# Mock hygiene — surviving Bun's process-global `mock.module`

> CCSTD-06 / PAR-301. Enforced by `scripts-v2/mock-hygiene-gate.ts`
> (wired into `just test-quality`, which `just ci` runs). Run it directly with
> `just mock-hygiene`.

## The hazard

Bun's `mock.module(id, factory)` mutates a **process-global** module registry,
and `mock.restore()` does **not** undo it (bun
[#7823](https://github.com/oven-sh/bun/issues/7823),
[#12823](https://github.com/oven-sh/bun/issues/12823),
[#6024](https://github.com/oven-sh/bun/issues/6024)). Whatever the last test
file registered for a given module id stays registered for every file that loads
afterwards in the same worker.

When the mocked module is a **shared pure module** — `node:fs`,
`node:fs/promises`, `node:child_process`, `vscode`, or an internal helper that
several suites import — a **partial** factory becomes a landmine:

```ts
// ☠️  leaks: every method except `watch` is now `undefined` for any file
//     that loads after this one and doesn't re-mock node:fs itself.
mock.module("node:fs", () => ({ watch: myWatchStub }));
```

The victim file calls, say, `fs.readFileSync(...)`, gets `undefined`, and throws
— but only when the two files happen to run in that order. The full suite stays
green purely by file load-order. This class of flake recurred three times during
the ledger work (a classifier pinned to a sibling stub, a
BinaryManager↔session-resolver `node:fs` leak, and the taskflow `ThemeColor`
leak).

> Bun's per-file isolation has improved (as of 1.3.x the focused suites are
> order-independent), but the runtime guarantee is not something to rely on. The
> patterns below make a leak structurally impossible instead of load-order-lucky.

## The safe patterns

### 1. Node builtins — fall through to the frozen real snapshot

`test/setup/global-test-cleanup.ts` (the bunfig `preload`) freezes the real
modules on `globalThis` **before any test file loads**:

- `globalThis.__realNodeFs`
- `globalThis.__realNodeFsPromises`
- `globalThis.__realNodeChildProcess`

Read those snapshots and **spread them** so unmocked methods fall through to the
real implementation instead of `undefined`:

```ts
const realFs = (globalThis as Record<string, unknown>)["__realNodeFs"] as
	typeof import("node:fs");

mock.module("node:fs", () => ({
	...realFs, // ← everything you don't override stays real
	watch: myWatchStub,
}));
```

Returning the snapshot directly (`mock.module("node:fs", () => realFs)`) or
pinning the real module via `require("node:fs")` is equally safe — both keep the
surface complete.

> **Never** take your own `import * as realFs from "node:fs"`. In Bun that
> namespace is a **live binding**: once any file mocks `node:fs`, your `realFs`
> reflects the *mock*, and spreading it produces a self-referential mock that can
> stall the event loop. Always read the frozen `globalThis.__realNode*` snapshot.

### 2. `vscode` — spread the canonical mock, never hand-roll a subset

The preload registers the full canonical surface
(`test/helpers/vscode-mock.ts` → `createVSCodeMock()`). A hand-rolled
`mock.module("vscode", () => ({ ThemeColor: class {} }))` **shrinks** that
surface globally, so a later file that needs `vscode.window` /
`vscode.EventEmitter` gets `undefined`. Spread the canonical mock and override
only what you need:

```ts
import { createVSCodeMock } from "../helpers/vscode-mock.js";

mock.module("vscode", () => createVSCodeMock());
// or, with an override:
mock.module("vscode", () => ({
	...createVSCodeMock(),
	workspace: { /* … your stub … */ },
}));
```

If a suite relies on the default global `vscode` mock, don't re-mock it at all —
let the preload's registration stand (many suites re-assert it in `beforeEach`
via `setupVSCodeMock()`).

### 3. Internal shared modules — mock at the boundary, not the shared leaf

Don't `mock.module` a pure internal module that other suites import (a
classifier, a resolver, a formatter). Pinning it to a stub changes behavior for
every later file. Prefer injecting the dependency, mocking the narrow module the
subject-under-test owns, or asserting against the real module.

## The gate

`scripts-v2/mock-hygiene-gate.ts` scans `test/**/*.ts` (excluding
`.legacy` / `_deleted` / `discovery-e2e`) and fails CI when a file mocks
`node:fs`, `node:fs/promises`, or `node:child_process` without referencing the
matching `__realNode*` snapshot or a `require()` real-pin. It is intentionally
scoped to the three incident-proven builtins; the `vscode` and internal-module
conventions above are enforced by review + this document.
