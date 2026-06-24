/**
 * Tests for OpenClawConfigService — per-agent model resolution and
 * resilient reload behavior.
 *
 * Regression: CP-21 / PAR-61 — a transiently malformed openclaw.json
 * (e.g. mid-edit) must NOT wipe the last known-good agent models.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type * as _fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Restore real node:fs to undo mock bleed from other test files.
// Use the cached reference saved by the preload (global-test-cleanup.ts)
// because require("node:fs") would return the already-mocked version.
const fs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof _fs;
mock.module("node:fs", () => fs);

// Re-import the service AFTER restoring real fs so it binds to real readFileSync.
const { OpenClawConfigService } = await import(
	"../../src/services/openclaw-config-service.js"
);

const VALID_CONFIG = JSON.stringify({
	agents: {
		defaults: { model: { primary: "claude-sonnet" }, thinkingDefault: "low" },
		list: [
			{
				id: "alpha",
				model: { primary: "claude-opus" },
				thinkingDefault: "high",
			},
			{ id: "beta" },
		],
	},
});

describe("OpenClawConfigService", () => {
	let tmpDir: string;
	let configPath: string;

	beforeEach(() => {
		// Re-register real node:fs after global afterEach's mock.restore().
		mock.module("node:fs", () => fs);
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-test-"));
		configPath = path.join(tmpDir, "openclaw.json");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("reload resolves explicit and inherited agent models", () => {
		fs.writeFileSync(configPath, VALID_CONFIG);
		const service = new OpenClawConfigService(configPath);
		service.reload();

		expect(service.getAgentModel("alpha")).toEqual({
			id: "alpha",
			model: "claude-opus",
			thinkingDefault: "high",
			isExplicit: true,
		});
		expect(service.getAgentModel("beta")).toEqual({
			id: "beta",
			model: "claude-sonnet",
			thinkingDefault: "low",
			isExplicit: false,
		});
		service.dispose();
	});

	// REGRESSION (CP-21 / PAR-61): a malformed config reload must preserve
	// the last known-good agent models instead of wiping them.
	test("malformed config reload preserves last known-good models", () => {
		fs.writeFileSync(configPath, VALID_CONFIG);
		const service = new OpenClawConfigService(configPath);
		service.reload();

		// Sanity: valid config loaded.
		expect(service.getAgentModel("alpha")?.model).toBe("claude-opus");
		expect(service.getAllAgentModels()).toHaveLength(2);

		// Simulate a mid-edit / truncated write producing invalid JSON.
		fs.writeFileSync(configPath, '{ "agents": { "list": [ { "id": ');
		service.reload();

		// Last known-good models must survive the malformed reload.
		expect(service.getAgentModel("alpha")).toEqual({
			id: "alpha",
			model: "claude-opus",
			thinkingDefault: "high",
			isExplicit: true,
		});
		expect(service.getAgentModel("beta")?.model).toBe("claude-sonnet");
		expect(service.getAllAgentModels()).toHaveLength(2);
		service.dispose();
	});

	test("reload after malformed config recovers when valid JSON returns", () => {
		fs.writeFileSync(configPath, VALID_CONFIG);
		const service = new OpenClawConfigService(configPath);
		service.reload();

		fs.writeFileSync(configPath, "{ not json");
		service.reload();
		expect(service.getAgentModel("alpha")?.model).toBe("claude-opus");

		// A new valid config with a different agent set should replace cleanly.
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				agents: { list: [{ id: "gamma", model: "claude-haiku" }] },
			}),
		);
		service.reload();
		expect(service.getAgentModel("gamma")?.model).toBe("claude-haiku");
		expect(service.getAgentModel("alpha")).toBeUndefined();
		expect(service.getAllAgentModels()).toHaveLength(1);
		service.dispose();
	});

	test("reload clears models when config file is deleted", () => {
		fs.writeFileSync(configPath, VALID_CONFIG);
		const service = new OpenClawConfigService(configPath);
		service.reload();
		expect(service.getAllAgentModels()).toHaveLength(2);

		fs.rmSync(configPath);
		service.reload();
		expect(service.getAllAgentModels()).toHaveLength(0);
		service.dispose();
	});
});
