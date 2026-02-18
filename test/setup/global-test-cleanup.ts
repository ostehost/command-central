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
import { createVSCodeMock } from "../helpers/vscode-mock.js";

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
