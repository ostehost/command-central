/**
 * BinaryManager Tests
 *
 * Tests isInstalled, getVersion, getLatestRelease, downloadRelease,
 * and getReleaseByTag using mocked fs and fetch.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── fs mock ───────────────────────────────────────────────────────────

const fsExistsSyncMock = mock((_p: string) => false);
const fsReadFileSyncMock = mock((_p: string, _enc: string) => "");
const fsMkdirSyncMock = mock(() => undefined);
const fsRmSyncMock = mock(() => undefined);
const fsRenameSyncMock = mock(() => undefined);
const fsWriteFileSyncMock = mock(() => undefined);

mock.module("node:fs", () => ({
	existsSync: fsExistsSyncMock,
	readFileSync: fsReadFileSyncMock,
	mkdirSync: fsMkdirSyncMock,
	rmSync: fsRmSyncMock,
	renameSync: fsRenameSyncMock,
	writeFileSync: fsWriteFileSyncMock,
}));

// ── child_process mock ────────────────────────────────────────────────

type ExecFileCallback = (
	err: Error | null,
	result: { stdout: string; stderr: string },
) => void;

const execFileMock = mock(
	(
		_file: string,
		_args: string[],
		_opts: object,
		callback: ExecFileCallback,
	) => {
		callback(null, { stdout: "", stderr: "" });
	},
);

mock.module("node:child_process", () => ({
	execFile: execFileMock,
}));

// ── Import after mocks ────────────────────────────────────────────────

import {
	BinaryManager,
	type GhosttyRelease,
} from "../../src/ghostty/BinaryManager.js";

// ── Logger mock ───────────────────────────────────────────────────────

function createMockLogger() {
	return {
		debug: mock(),
		info: mock(),
		warn: mock(),
		error: mock(),
	};
}

/** Set globalThis.fetch with a compatible type cast */
// biome-ignore lint: test helper cast
function setFetchMock(fn: (...args: unknown[]) => unknown): void {
	// biome-ignore lint: test helper cast
	(globalThis as Record<string, unknown>)["fetch"] = fn;
}

// ── Helper: create a mock release ────────────────────────────────────

function createMockRelease(tag = "v1.2.3"): GhosttyRelease {
	return {
		tag_name: tag,
		assets: [
			{
				name: `Ghostty-CC-dev-abc1234.zip`,
				browser_download_url: `https://example.com/releases/${tag}/Ghostty-CC-dev-abc1234.zip`,
			},
		],
	};
}

function makeFsSetup() {
	return () => {
		mock.restore();
		mock.module("node:fs", () => ({
			existsSync: fsExistsSyncMock,
			readFileSync: fsReadFileSyncMock,
			mkdirSync: fsMkdirSyncMock,
			rmSync: fsRmSyncMock,
			renameSync: fsRenameSyncMock,
			writeFileSync: fsWriteFileSyncMock,
		}));
		mock.module("node:child_process", () => ({ execFile: execFileMock }));
	};
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("BinaryManager.isInstalled", () => {
	beforeEach(makeFsSetup());

	test("returns false when Info.plist does not exist", async () => {
		fsExistsSyncMock.mockImplementation(() => false);
		const mgr = new BinaryManager(createMockLogger() as never);
		expect(await mgr.isInstalled()).toBe(false);
	});

	test("returns true when Info.plist contains Ghostty bundle ID", async () => {
		fsExistsSyncMock.mockImplementation(() => true);
		fsReadFileSyncMock.mockImplementation(
			() =>
				`<key>CFBundleIdentifier</key><string>com.mitchellh.ghostty</string>`,
		);
		const mgr = new BinaryManager(createMockLogger() as never);
		expect(await mgr.isInstalled()).toBe(true);
	});

	test("returns false when Info.plist lacks Ghostty bundle ID", async () => {
		fsExistsSyncMock.mockImplementation(() => true);
		fsReadFileSyncMock.mockImplementation(
			() => `<key>CFBundleIdentifier</key><string>com.other.app</string>`,
		);
		const mgr = new BinaryManager(createMockLogger() as never);
		expect(await mgr.isInstalled()).toBe(false);
	});

	test("returns false when readFileSync throws", async () => {
		fsExistsSyncMock.mockImplementation(() => true);
		fsReadFileSyncMock.mockImplementation(() => {
			throw new Error("permission denied");
		});
		const mgr = new BinaryManager(createMockLogger() as never);
		expect(await mgr.isInstalled()).toBe(false);
	});
});

describe("BinaryManager.getVersion", () => {
	beforeEach(makeFsSetup());

	test("parses CFBundleVersion and CCCommitHash from plist", async () => {
		fsReadFileSyncMock.mockImplementation(
			() =>
				`<key>CFBundleVersion</key>\n<string>1.2.3</string>\n` +
				`<key>CCCommitHash</key>\n<string>abc1234def</string>`,
		);
		const mgr = new BinaryManager(createMockLogger() as never);
		const info = await mgr.getVersion();
		expect(info.bundleVersion).toBe("1.2.3");
		expect(info.commitHash).toBe("abc1234def");
	});

	test("returns nulls when plist cannot be read", async () => {
		fsReadFileSyncMock.mockImplementation(() => {
			throw new Error("file not found");
		});
		const mgr = new BinaryManager(createMockLogger() as never);
		const info = await mgr.getVersion();
		expect(info.bundleVersion).toBeNull();
		expect(info.commitHash).toBeNull();
	});

	test("returns null commitHash when CCCommitHash is absent", async () => {
		fsReadFileSyncMock.mockImplementation(
			() => `<key>CFBundleVersion</key>\n<string>2.0.0</string>`,
		);
		const mgr = new BinaryManager(createMockLogger() as never);
		const info = await mgr.getVersion();
		expect(info.bundleVersion).toBe("2.0.0");
		expect(info.commitHash).toBeNull();
	});
});

describe("BinaryManager.getLatestRelease", () => {
	beforeEach(makeFsSetup());

	test("returns release data on success", async () => {
		const release = createMockRelease("v1.5.0");
		setFetchMock(() =>
			Promise.resolve({ ok: true, json: () => Promise.resolve(release) }),
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		const result = await mgr.getLatestRelease();
		expect(result.tag_name).toBe("v1.5.0");
		expect(result.assets).toHaveLength(1);
	});

	test("throws when GitHub API returns non-ok status", async () => {
		setFetchMock(() =>
			Promise.resolve({ ok: false, status: 404, statusText: "Not Found" }),
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		await expect(mgr.getLatestRelease()).rejects.toThrow(
			"GitHub API returned 404",
		);
	});

	test("throws when response has unexpected shape", async () => {
		setFetchMock(() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ wrong: "data" }),
			}),
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		await expect(mgr.getLatestRelease()).rejects.toThrow(
			"Unexpected GitHub API response format",
		);
	});
});

describe("BinaryManager.downloadRelease", () => {
	beforeEach(makeFsSetup());

	test("downloads, extracts, and validates the release", async () => {
		const release = createMockRelease("v2.0.0");
		const fetchCalls: string[] = [];

		setFetchMock((url: unknown) => {
			const urlStr = String(url);
			fetchCalls.push(urlStr);
			if (urlStr.includes("releases/tags")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(release),
				});
			}
			return Promise.resolve({
				ok: true,
				arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
			});
		});

		// No existing install initially; after extraction, app exists
		let extracted = false;
		fsExistsSyncMock.mockImplementation((p: unknown) => {
			const ps = String(p);
			if (extracted && ps.includes("Info.plist")) return true;
			if (extracted && ps.includes("Ghostty.app")) return true;
			return false;
		});

		// After extraction, plist is readable with correct bundle ID
		fsReadFileSyncMock.mockImplementation(
			() =>
				`<key>CFBundleIdentifier</key><string>com.mitchellh.ghostty</string>`,
		);

		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				extracted = true; // simulate extraction completing
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		mgr.installPath = "/tmp/test-ghostty/Ghostty.app";

		await mgr.downloadRelease("v2.0.0");

		// mkdirSync should have been called to create install dir
		expect(fsMkdirSyncMock).toHaveBeenCalled();
		// writeFileSync should have been called to save the zip
		expect(fsWriteFileSyncMock).toHaveBeenCalled();
	});

	test("restores backup when validation fails after extraction", async () => {
		const release = createMockRelease("v2.0.0");

		setFetchMock((url: unknown) => {
			const urlStr = String(url);
			if (urlStr.includes("releases/tags")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(release),
				});
			}
			return Promise.resolve({
				ok: true,
				arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
			});
		});

		// First call: existing install present, subsequent calls for plist check
		let callCount = 0;
		fsExistsSyncMock.mockImplementation(() => {
			callCount++;
			return callCount <= 2;
		});

		// Plist read fails → validation fails → isInstalled returns false
		fsReadFileSyncMock.mockImplementation(() => {
			throw new Error("no plist");
		});

		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		mgr.installPath = "/tmp/test-ghostty/Ghostty.app";

		await expect(mgr.downloadRelease("v2.0.0")).rejects.toThrow(
			"Ghostty app validation failed",
		);

		// Rename should have been called to restore backup
		expect(fsRenameSyncMock).toHaveBeenCalled();
	});

	test("throws when no zip asset found in release", async () => {
		const release: GhosttyRelease = {
			tag_name: "v3.0.0",
			assets: [
				{
					name: "checksums.txt",
					browser_download_url: "https://example.com/checksums.txt",
				},
			],
		};

		setFetchMock(() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve(release),
			}),
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		await expect(mgr.downloadRelease("v3.0.0")).rejects.toThrow(
			"No zip asset found",
		);
	});
});

describe("BinaryManager.getReleaseByTag", () => {
	beforeEach(makeFsSetup());

	test("fetches release by specific tag", async () => {
		const release = createMockRelease("v1.0.0");
		const fetchedUrls: string[] = [];

		setFetchMock((url: unknown) => {
			fetchedUrls.push(String(url));
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve(release),
			});
		});

		const mgr = new BinaryManager(createMockLogger() as never);
		const result = await mgr.getReleaseByTag("v1.0.0");

		expect(result.tag_name).toBe("v1.0.0");
		expect(fetchedUrls[0]).toContain("/releases/tags/v1.0.0");
	});

	test("throws on non-ok API response", async () => {
		setFetchMock(() =>
			Promise.resolve({ ok: false, status: 403, statusText: "Forbidden" }),
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		await expect(mgr.getReleaseByTag("v1.0.0")).rejects.toThrow(
			"GitHub API returned 403",
		);
	});
});
