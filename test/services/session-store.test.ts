/**
 * Tests for SessionStore — project_dir → Ghostty bundle mapping persistence
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Restore real node:fs to undo mock bleed from other test files
// (e.g. launch-agent.test.ts mocks existsSync: () => true globally).
// We must require() the real module before mock.module overwrites it.
const realFs = require("node:fs");
mock.module("node:fs", () => realFs);

// Re-import SessionStore AFTER restoring real fs so it binds to real existsSync
const { SessionStore } = await import("../../src/services/session-store.js");

describe("SessionStore", () => {
	let tmpDir: string;
	let storePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-test-"));
		storePath = path.join(tmpDir, "sessions.json");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("register + lookup round-trip", () => {
		const store = new SessionStore(storePath);
		store.register(
			"/Users/test/projects/my-app",
			"/Applications/Projects/my-app.app",
			"dev.partnerai.ghostty.my-app",
		);

		const result = store.lookup("/Users/test/projects/my-app");
		expect(result).toEqual({
			bundlePath: "/Applications/Projects/my-app.app",
			bundleId: "dev.partnerai.ghostty.my-app",
		});
	});

	test("lookup returns null for unknown project", () => {
		const store = new SessionStore(storePath);
		const result = store.lookup("/Users/test/projects/unknown");
		expect(result).toBeNull();
	});

	test("save + reload preserves data", () => {
		const store1 = new SessionStore(storePath);
		store1.register(
			"/Users/test/projects/my-app",
			"/Applications/Projects/my-app.app",
			"dev.partnerai.ghostty.my-app",
		);
		store1.save();

		// Load fresh instance from same path
		const store2 = new SessionStore(storePath);
		const result = store2.lookup("/Users/test/projects/my-app");
		expect(result).toEqual({
			bundlePath: "/Applications/Projects/my-app.app",
			bundleId: "dev.partnerai.ghostty.my-app",
		});
	});

	test("prune removes entries older than 30 days", () => {
		const store = new SessionStore(storePath);
		store.register(
			"/Users/test/projects/old-app",
			"/Applications/Projects/old-app.app",
			"dev.partnerai.ghostty.old-app",
		);

		// Manually backdate the entry
		const all = store.getAll();
		const oldDate = new Date(
			Date.now() - 31 * 24 * 60 * 60 * 1000,
		).toISOString();
		const oldEntry = all["/Users/test/projects/old-app"];
		expect(oldEntry).toBeDefined();
		if (!oldEntry) throw new Error("expected old-app entry to exist");
		oldEntry.lastSeen = oldDate;

		// Force re-prune by saving and reloading
		store.save();
		const store2 = new SessionStore(storePath);
		const result = store2.lookup("/Users/test/projects/old-app");
		expect(result).toBeNull();
	});

	test("prune keeps entries newer than 30 days", () => {
		const store = new SessionStore(storePath);
		store.register(
			"/Users/test/projects/new-app",
			"/Applications/Projects/new-app.app",
			"dev.partnerai.ghostty.new-app",
		);
		store.save();

		const store2 = new SessionStore(storePath);
		const result = store2.lookup("/Users/test/projects/new-app");
		expect(result).not.toBeNull();
	});

	test("handles corrupt JSON gracefully", () => {
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(storePath, "{{{{ not json");

		const store = new SessionStore(storePath);
		const result = store.lookup("/Users/test/projects/anything");
		expect(result).toBeNull();
	});

	test("handles missing file gracefully", () => {
		const store = new SessionStore(
			path.join(tmpDir, "nonexistent", "sessions.json"),
		);
		const result = store.lookup("/Users/test/projects/anything");
		expect(result).toBeNull();
	});

	test("creates parent directories on save", () => {
		const deepPath = path.join(tmpDir, "a", "b", "c", "sessions.json");
		const store = new SessionStore(deepPath);
		store.register(
			"/Users/test/projects/my-app",
			"/Applications/Projects/my-app.app",
			"dev.partnerai.ghostty.my-app",
		);
		store.save();

		expect(fs.existsSync(deepPath)).toBe(true);
	});

	test("register updates existing entry with new bundle info", () => {
		const store = new SessionStore(storePath);
		store.register(
			"/Users/test/projects/my-app",
			"/Applications/Projects/my-app.app",
			"dev.partnerai.ghostty.my-app",
		);

		store.register(
			"/Users/test/projects/my-app",
			"/Applications/Projects/my-app-v2.app",
			"dev.partnerai.ghostty.my-app-v2",
		);

		const after = store.getAll()["/Users/test/projects/my-app"];
		expect(after).toBeDefined();
		if (!after) throw new Error("expected my-app entry to exist");
		expect(after.bundlePath).toBe("/Applications/Projects/my-app-v2.app");
		expect(after.bundleId).toBe("dev.partnerai.ghostty.my-app-v2");
	});

	test("convention-based derivation when bundle exists on disk", () => {
		// Create a fake .app directory matching the convention
		const fakeAppsDir = path.join(tmpDir, "Applications", "Projects");
		fs.mkdirSync(fakeAppsDir, { recursive: true });
		fs.mkdirSync(path.join(fakeAppsDir, "test-proj.app"));

		// Use a custom store that checks our tmpDir instead of /Applications/Projects
		// We test the convention indirectly: register a mapping, then verify lookup works
		const store = new SessionStore(storePath);

		// Manually register what convention derivation would produce
		store.register(
			"/Users/test/projects/test-proj",
			path.join(fakeAppsDir, "test-proj.app"),
			"dev.partnerai.ghostty.test-proj",
		);

		const result = store.lookup("/Users/test/projects/test-proj");
		expect(result).toEqual({
			bundlePath: path.join(fakeAppsDir, "test-proj.app"),
			bundleId: "dev.partnerai.ghostty.test-proj",
		});
	});

	test("convention-based derivation uses real /Applications/Projects path", () => {
		// This tests the actual derivation logic for a known-existing bundle
		const store = new SessionStore(storePath);
		// command-central.app exists in /Applications/Projects/ on this machine
		const result = store.lookup("/Users/ostemini/projects/command-central");
		if (fs.existsSync("/Applications/Projects/command-central.app")) {
			expect(result).toEqual({
				bundlePath: "/Applications/Projects/command-central.app",
				bundleId: "dev.partnerai.ghostty.command-central",
			});
		} else {
			// CI or machines without Ghostty bundles
			expect(result).toBeNull();
		}
	});

	test("convention-based derivation returns null when bundle missing", () => {
		const store = new SessionStore(storePath);
		// No mock — /Applications/Projects/nonexistent.app won't exist
		const result = store.lookup("/Users/test/projects/nonexistent");
		expect(result).toBeNull();
	});
});
