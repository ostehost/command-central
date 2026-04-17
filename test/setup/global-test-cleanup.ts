/**
 * Global Test Cleanup - Prevents Test Pollution
 *
 * Ensures all mocks are properly cleaned up after each test
 * to prevent interference between test files.
 *
 * This fixes issues where tests pass individually but fail in full suite.
 *
 * IMPORTANT: This file is loaded via bunfig.toml preload BEFORE any test files.
 * The vscode mock must be registered at module scope to intercept static imports.
 */

import { afterAll, afterEach, mock } from "bun:test";
// Cache real core modules BEFORE any test file can mock them.
// IMPORTANT: Spread into a plain object to freeze the reference. In Bun,
// `import * as ns` creates a live namespace that mutates when mock.module()
// is called — spreading breaks the live binding so the real functions survive.
// Test files should use these snapshots via `globalThis.__realNodeFs` /
// `globalThis.__realNodeChildProcess` instead of taking their own
// `import * as real...` spread, which is already too late once another
// test file has installed a mock during bun's discovery phase.
import * as _realNodeChildProcessLive from "node:child_process";
import * as _realNodeFsLive from "node:fs";
import * as _realNodeFsPromisesLive from "node:fs/promises";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const _realNodeFs = { ..._realNodeFsLive };
const _realNodeFsPromises = { ..._realNodeFsPromisesLive };
const _realNodeChildProcess = { ..._realNodeChildProcessLive };
(globalThis as Record<string, unknown>)["__realNodeFs"] = _realNodeFs;
(globalThis as Record<string, unknown>)["__realNodeFsPromises"] =
	_realNodeFsPromises;
(globalThis as Record<string, unknown>)["__realNodeChildProcess"] =
	_realNodeChildProcess;

// Optional instrumentation: set CC_HARNESS_TRACE=1 to dump per-command
// fall-through counts + wall-time from the AgentStatusTreeProvider test
// harness at process exit. Diagnostic only — cheap when disabled.
if (process.env["CC_HARNESS_TRACE"] === "1") {
	const counts = new Map<string, number>();
	const ms = new Map<string, number>();
	const stageMs = new Map<string, { n: number; ms: number }>();
	(globalThis as Record<string, unknown>)["__ccHarnessCallCounts"] = counts;
	(globalThis as Record<string, unknown>)["__ccHarnessMsByCmd"] = ms;
	(globalThis as Record<string, unknown>)["__ccHarnessStageMs"] = stageMs;

	const dump = () => {
		const traceFile = "/tmp/cc-harness-trace.log";
		const lines: string[] = ["── CC_HARNESS_TRACE ──"];

		lines.push("", "## Harness stage timings (per-test setup cost)");
		const stageRows = [...stageMs.entries()].sort((a, b) => b[1].ms - a[1].ms);
		let stageTotal = 0;
		for (const [k, v] of stageRows) {
			stageTotal += v.ms;
			lines.push(
				`  ${v.ms.toFixed(0).padStart(8)}ms  ${String(v.n).padStart(5)}×  ${k}`,
			);
		}
		lines.push(
			`  ${stageTotal.toFixed(0).padStart(8)}ms  TOTAL harness stages`,
		);

		lines.push("", "## Fall-through execFileSync commands");
		const cmdRows = [...counts.entries()]
			.map(([k, n]) => [k, n, ms.get(k) ?? 0] as [string, number, number])
			.sort((a, b) => b[2] - a[2]);
		let cmdTotal = 0;
		let cmdCalls = 0;
		for (const [k, n, t] of cmdRows) {
			cmdTotal += t;
			cmdCalls += n;
			lines.push(
				`  ${t.toFixed(0).padStart(8)}ms  ${String(n).padStart(5)}×  ${k}`,
			);
		}
		lines.push(
			`  ${cmdTotal.toFixed(0).padStart(8)}ms  ${String(cmdCalls).padStart(5)}×  TOTAL fall-through`,
		);

		const out = `${lines.join("\n")}\n`;
		try {
			_realNodeFs.writeFileSync(traceFile, out);
		} catch {
			/* swallow */
		}
		process.stderr.write(out);
	};
	process.on("exit", dump);
	process.on("beforeExit", dump);
	// Bun's test runner does not reliably fire process exit handlers. An
	// afterAll at preload scope runs once after the full suite completes
	// inside each worker, which is what we want for trace output.
	afterAll(dump);
}

// Register vscode mock GLOBALLY before any test file imports modules
// This runs ONCE at worker startup - fixes static import issue
// (typed-mocks.ts → terminal-launcher-service.ts → logger-service.ts → vscode)
mock.module("vscode", () => createVSCodeMock());

// Snapshot process.env at preload so we can restore it after every test.
// 12+ test files mutate process.env (NODE_ENV, agent config keys, etc.) and
// most don't restore explicitly. Without this, env values leak across files
// and produce flakes that depend on file load order.
const _envSnapshot: Record<string, string | undefined> = { ...process.env };

// Force cleanup after EVERY test
// Note: Test files call setupVSCodeMock() in beforeEach to re-register fresh mocks
afterEach(() => {
	// Restore all mocks to prevent pollution
	mock.restore();

	// Restore process.env to its preload state.
	// 1. Delete keys that were added by the test
	for (const k of Object.keys(process.env)) {
		if (!(k in _envSnapshot)) delete process.env[k];
	}
	// 2. Restore keys that the test mutated (or deleted)
	for (const [k, v] of Object.entries(_envSnapshot)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

// Safety net: unref() all setInterval AND setTimeout handles so they don't
// prevent process exit. Production modules loaded during tests may create
// timers that keep the event loop alive. Bun lacks --forceExit.
const _originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
	const id = _originalSetInterval(...args);
	if (id && typeof id === "object" && "unref" in id) {
		(id as NodeJS.Timeout).unref();
	}
	return id;
}) as typeof setInterval;

const _originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
	const id = _originalSetTimeout(...args);
	if (id && typeof id === "object" && "unref" in id) {
		(id as NodeJS.Timeout).unref();
	}
	return id;
}) as typeof setTimeout;
