/**
 * Tests for SessionStore — project_dir → Ghostty bundle mapping persistence
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../../src/services/session-store.js";

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
		all["/Users/test/projects/old-app"]!.lastSeen = oldDate;

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

	test("register updates existing entry with new timestamp", () => {
		const store = new SessionStore(storePath);
		store.register(
			"/Users/test/projects/my-app",
			"/Applications/Projects/my-app.app",
			"dev.partnerai.ghostty.my-app",
		);

		const before = store.getAll()["/Users/test/projects/my-app"]!.lastSeen;

		// Small delay to ensure timestamp differs
		store.register(
			"/Users/test/projects/my-app",
			"/Applications/Projects/my-app-v2.app",
			"dev.partnerai.ghostty.my-app-v2",
		);

		const after = store.getAll()["/Users/test/projects/my-app"]!;
		expect(after.bundlePath).toBe("/Applications/Projects/my-app-v2.app");
		expect(after.bundleId).toBe("dev.partnerai.ghostty.my-app-v2");
		expect(after.lastSeen).not.toBe(before);
	});

	test("convention-based derivation when bundle exists on disk", () => {
		// Mock fs.existsSync for the derived path
		const originalExistsSync = fs.existsSync;
		const existsSyncMock = mock((p: fs.PathLike) => {
			if (String(p) === "/Applications/Projects/my-project.app") {
				return true;
			}
			return originalExistsSync(p);
		});
		// Temporarily replace
		(fs as { existsSync: typeof fs.existsSync }).existsSync =
			existsSyncMock;

		try {
			const store = new SessionStore(storePath);
			const result = store.lookup("/Users/test/projects/my-project");
			expect(result).toEqual({
				bundlePath: "/Applications/Projects/my-project.app",
				bundleId: "dev.partnerai.ghostty.my-project",
			});

			// Should be cached now
			const all = store.getAll();
			expect(all["/Users/test/projects/my-project"]).toBeDefined();
		} finally {
			(fs as { existsSync: typeof fs.existsSync }).existsSync =
				originalExistsSync;
		}
	});

	test("convention-based derivation returns null when bundle missing", () => {
		const store = new SessionStore(storePath);
		// No mock — /Applications/Projects/nonexistent.app won't exist
		const result = store.lookup("/Users/test/projects/nonexistent");
		expect(result).toBeNull();
	});
});
