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

import { afterEach, mock } from "bun:test";
// Cache real node:fs BEFORE any test file can mock it.
// IMPORTANT: Spread into a plain object to freeze the reference. In Bun,
// `import * as ns` creates a live namespace that mutates when mock.module()
// is called — spreading breaks the live binding so the real functions survive.
import * as _realNodeFsLive from "node:fs";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const _realNodeFs = { ..._realNodeFsLive };
(globalThis as Record<string, unknown>)["__realNodeFs"] = _realNodeFs;

// Register vscode mock GLOBALLY before any test file imports modules
// This runs ONCE at worker startup - fixes static import issue
// (typed-mocks.ts → terminal-launcher-service.ts → logger-service.ts → vscode)
mock.module("vscode", () => createVSCodeMock());

// Force cleanup after EVERY test
// Note: Test files call setupVSCodeMock() in beforeEach to re-register fresh mocks
afterEach(() => {
	// Restore all mocks to prevent pollution
	mock.restore();
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
