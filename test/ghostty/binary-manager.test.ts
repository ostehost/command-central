/**
 * BinaryManager Tests
 *
 * Tests isInstalled, getVersion, getLatestRelease, downloadRelease,
 * getReleaseByTag, checkForUpdates, SHA256 verification, and auth flow
 * using mocked fs, fetch, crypto, and vscode.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

// ── fs mock ───────────────────────────────────────────────────────────

const fsExistsSyncMock = mock((_p: string) => false);
const fsReadFileSyncMock = mock((_p: string, _enc?: string) => "");
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

// ── vscode mock ───────────────────────────────────────────────────────

const vsCodeGetSessionMock = mock(
	(_providerId: string, _scopes: string[], _options: object) =>
		Promise.resolve(undefined),
);

mock.module("vscode", () => ({
	authentication: {
		getSession: vsCodeGetSessionMock,
	},
}));

// ── Import after mocks ────────────────────────────────────────────────

import {
	BinaryManager,
	type GhosttyRelease,
	type UpdateCheckResult,
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
function setFetchMock(fn: (...args: unknown[]) => unknown): void {
	(globalThis as Record<string, unknown>)["fetch"] = fn;
}

// ── Mock globalState (vscode.Memento) ─────────────────────────────────

function createMockGlobalState(): {
	get: <T>(key: string, defaultValue?: T) => T | undefined;
	update: (key: string, value: unknown) => Promise<void>;
	keys: () => readonly string[];
	setKeysForSync: (keys: readonly string[]) => void;
	_store: Map<string, unknown>;
} {
	const store = new Map<string, unknown>();
	return {
		get<T>(key: string, defaultValue?: T): T | undefined {
			return (store.get(key) as T | undefined) ?? defaultValue;
		},
		update(key: string, value: unknown): Promise<void> {
			store.set(key, value);
			return Promise.resolve();
		},
		keys(): readonly string[] {
			return [...store.keys()];
		},
		setKeysForSync(_keys: readonly string[]): void {
			// no-op for tests
		},
		_store: store,
	};
}

// ── Helper: create a mock release ────────────────────────────────────

function createMockRelease(tag = "cc-v1.2.3"): GhosttyRelease {
	const zipName = "Ghostty-CC-dev-abc1234.zip";
	return {
		tag_name: tag,
		assets: [
			{
				name: zipName,
				browser_download_url: `https://example.com/releases/${tag}/${zipName}`,
			},
			{
				name: `${zipName}.sha256`,
				browser_download_url: `https://example.com/releases/${tag}/${zipName}.sha256`,
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
		mock.module("vscode", () => ({
			authentication: {
				getSession: vsCodeGetSessionMock,
			},
		}));
		// Default: no auth token
		vsCodeGetSessionMock.mockImplementation(() => Promise.resolve(undefined));
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

	test("returns true when Info.plist contains upstream Ghostty bundle ID", async () => {
		fsExistsSyncMock.mockImplementation(() => true);
		fsReadFileSyncMock.mockImplementation(
			() =>
				`<key>CFBundleIdentifier</key><string>com.mitchellh.ghostty</string>`,
		);
		const mgr = new BinaryManager(createMockLogger() as never);
		expect(await mgr.isInstalled()).toBe(true);
	});

	test("returns true when Info.plist contains CC fork bundle ID", async () => {
		fsExistsSyncMock.mockImplementation(() => true);
		fsReadFileSyncMock.mockImplementation(
			() =>
				`<key>CFBundleIdentifier</key><string>dev.partnerai.ghostty.cc</string>`,
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

	test("parses CFBundleVersion and CCForkCommit from plist", async () => {
		fsReadFileSyncMock.mockImplementation(
			() =>
				`<key>CFBundleVersion</key>\n<string>1.2.3</string>\n` +
				`<key>CCForkCommit</key>\n<string>abc1234def</string>\n` +
				`<key>CCForkBuildDate</key>\n<string>2026-03-01</string>`,
		);
		const mgr = new BinaryManager(createMockLogger() as never);
		const info = await mgr.getVersion();
		expect(info.bundleVersion).toBe("1.2.3");
		expect(info.commitHash).toBe("abc1234def");
		expect(info.buildDate).toBe("2026-03-01");
	});

	test("returns nulls when plist cannot be read", async () => {
		fsReadFileSyncMock.mockImplementation(() => {
			throw new Error("file not found");
		});
		const mgr = new BinaryManager(createMockLogger() as never);
		const info = await mgr.getVersion();
		expect(info.bundleVersion).toBeNull();
		expect(info.commitHash).toBeNull();
		expect(info.buildDate).toBeNull();
	});

	test("returns null commitHash and buildDate when keys are absent", async () => {
		fsReadFileSyncMock.mockImplementation(
			() => `<key>CFBundleVersion</key>\n<string>2.0.0</string>`,
		);
		const mgr = new BinaryManager(createMockLogger() as never);
		const info = await mgr.getVersion();
		expect(info.bundleVersion).toBe("2.0.0");
		expect(info.commitHash).toBeNull();
		expect(info.buildDate).toBeNull();
	});
});

describe("BinaryManager.getLatestRelease", () => {
	beforeEach(makeFsSetup());

	test("returns release data on success", async () => {
		const release = createMockRelease("cc-v1.5.0");
		setFetchMock(() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve(release),
			}),
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		const result = await mgr.getLatestRelease();
		expect(result.tag_name).toBe("cc-v1.5.0");
		expect(result.assets).toHaveLength(2);
	});

	test("throws when GitHub API returns non-ok status", async () => {
		setFetchMock(() =>
			Promise.resolve({
				ok: false,
				status: 404,
				statusText: "Not Found",
			}),
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

	test("retries with OAuth prompt on 404 when unauthenticated", async () => {
		let callCount = 0;
		setFetchMock(() => {
			callCount++;
			if (callCount === 1) {
				return Promise.resolve({
					ok: false,
					status: 404,
					statusText: "Not Found",
				});
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve(createMockRelease("cc-v2.0.0")),
			});
		});

		// Subclass to control token flow: no token first, then token on retry
		let tokenCallCount = 0;
		class RetryTestManager extends BinaryManager {
			protected override async getGitHubToken(
				_createIfNone = false,
			): Promise<string | undefined> {
				tokenCallCount++;
				return tokenCallCount <= 1 ? undefined : "ghp_test_token";
			}
		}

		const mgr = new RetryTestManager(createMockLogger() as never);
		const result = await mgr.getLatestRelease();
		expect(result.tag_name).toBe("cc-v2.0.0");
		expect(callCount).toBe(2);
	});
});

describe("BinaryManager.checkForUpdates", () => {
	beforeEach(makeFsSetup());

	test("reports update available when no tag stored", async () => {
		const release = createMockRelease("cc-v1.0.0");
		setFetchMock(() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve(release),
			}),
		);

		const globalState = createMockGlobalState();
		const mgr = new BinaryManager(
			createMockLogger() as never,
			globalState as never,
		);
		const result: UpdateCheckResult = await mgr.checkForUpdates();

		expect(result.updateAvailable).toBe(true);
		expect(result.latestTag).toBe("cc-v1.0.0");
		expect(result.installedTag).toBeNull();
	});

	test("reports no update when stored tag matches latest", async () => {
		const release = createMockRelease("cc-v1.0.0");
		setFetchMock(() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve(release),
			}),
		);

		const globalState = createMockGlobalState();
		globalState._store.set("ghostty.installedTag", "cc-v1.0.0");
		const mgr = new BinaryManager(
			createMockLogger() as never,
			globalState as never,
		);
		const result: UpdateCheckResult = await mgr.checkForUpdates();

		expect(result.updateAvailable).toBe(false);
		expect(result.latestTag).toBe("cc-v1.0.0");
		expect(result.installedTag).toBe("cc-v1.0.0");
	});

	test("reports update available when stored tag differs", async () => {
		const release = createMockRelease("cc-v2.0.0");
		setFetchMock(() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve(release),
			}),
		);

		const globalState = createMockGlobalState();
		globalState._store.set("ghostty.installedTag", "cc-v1.0.0");
		const mgr = new BinaryManager(
			createMockLogger() as never,
			globalState as never,
		);
		const result: UpdateCheckResult = await mgr.checkForUpdates();

		expect(result.updateAvailable).toBe(true);
		expect(result.latestTag).toBe("cc-v2.0.0");
		expect(result.installedTag).toBe("cc-v1.0.0");
	});
});

describe("BinaryManager.downloadRelease", () => {
	beforeEach(makeFsSetup());

	test("downloads, verifies SHA256, extracts, and validates the release", async () => {
		const tag = "cc-v2.0.0";
		const release = createMockRelease(tag);
		const fetchCalls: string[] = [];

		// Content that readFileSync will return for the zip path
		const plistContent = `<key>CFBundleIdentifier</key><string>com.mitchellh.ghostty</string>`;
		const zipFileContent = "mock-zip-binary-content";
		const expectedHash = createHash("sha256")
			.update(zipFileContent)
			.digest("hex");

		setFetchMock((url: unknown) => {
			const urlStr = String(url);
			fetchCalls.push(urlStr);
			if (urlStr.includes("releases/tags")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(release),
				});
			}
			if (urlStr.includes(".sha256")) {
				return Promise.resolve({
					ok: true,
					text: () =>
						Promise.resolve(`${expectedHash}  Ghostty-CC-dev-abc1234.zip`),
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

		// readFileSync: return plist for Info.plist, zip content for zip files
		fsReadFileSyncMock.mockImplementation((p: unknown) => {
			const ps = String(p);
			if (ps.endsWith(".zip")) return zipFileContent;
			return plistContent;
		});

		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				extracted = true; // simulate extraction completing
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const globalState = createMockGlobalState();
		const mgr = new BinaryManager(
			createMockLogger() as never,
			globalState as never,
		);
		mgr.installPath = "/tmp/test-ghostty/Ghostty.app";

		await mgr.downloadRelease(tag);

		// mkdirSync should have been called to create install dir
		expect(fsMkdirSyncMock).toHaveBeenCalled();
		// writeFileSync should have been called to save the zip
		expect(fsWriteFileSyncMock).toHaveBeenCalled();
		// SHA256 checksum should have been fetched
		expect(fetchCalls.some((u) => u.includes(".sha256"))).toBe(true);
		// Tag should be stored in globalState
		expect(globalState._store.get("ghostty.installedTag")).toBe(tag);
	});

	test("restores backup when validation fails after extraction", async () => {
		const release = createMockRelease("cc-v2.0.0");

		setFetchMock((url: unknown) => {
			const urlStr = String(url);
			if (urlStr.includes("releases/tags")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(release),
				});
			}
			if (urlStr.includes(".sha256")) {
				// Return matching hash for whatever readFileSync gives us
				const hash = createHash("sha256").update("").digest("hex");
				return Promise.resolve({
					ok: true,
					text: () => Promise.resolve(hash),
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

		// readFileSync returns empty string for zip hash, throws for plist
		fsReadFileSyncMock.mockImplementation((p: unknown) => {
			const ps = String(p);
			if (ps.endsWith(".zip")) return "";
			throw new Error("no plist");
		});

		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		mgr.installPath = "/tmp/test-ghostty/Ghostty.app";

		await expect(mgr.downloadRelease("cc-v2.0.0")).rejects.toThrow(
			"Ghostty app validation failed",
		);

		// Rename should have been called to restore backup
		expect(fsRenameSyncMock).toHaveBeenCalled();
	});

	test("throws when no zip asset found in release", async () => {
		const release: GhosttyRelease = {
			tag_name: "cc-v3.0.0",
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
		await expect(mgr.downloadRelease("cc-v3.0.0")).rejects.toThrow(
			"No zip asset found",
		);
	});

	test("throws on SHA256 mismatch", async () => {
		const tag = "cc-v2.0.0";
		const release = createMockRelease(tag);

		setFetchMock((url: unknown) => {
			const urlStr = String(url);
			if (urlStr.includes("releases/tags")) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(release),
				});
			}
			if (urlStr.includes(".sha256")) {
				return Promise.resolve({
					ok: true,
					text: () =>
						Promise.resolve(
							"0000000000000000000000000000000000000000000000000000000000000000",
						),
				});
			}
			return Promise.resolve({
				ok: true,
				arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
			});
		});

		fsExistsSyncMock.mockImplementation(() => false);
		fsReadFileSyncMock.mockImplementation(() => "zip-file-content");

		const mgr = new BinaryManager(createMockLogger() as never);
		mgr.installPath = "/tmp/test-ghostty/Ghostty.app";

		await expect(mgr.downloadRelease(tag)).rejects.toThrow("SHA256 mismatch");
	});

	test("skips SHA256 verification when no checksum asset exists", async () => {
		const tag = "cc-v2.0.0";
		const release: GhosttyRelease = {
			tag_name: tag,
			assets: [
				{
					name: "Ghostty-CC-dev-abc1234.zip",
					browser_download_url: `https://example.com/releases/${tag}/Ghostty-CC-dev-abc1234.zip`,
				},
			],
		};

		const plistContent = `<key>CFBundleIdentifier</key><string>com.mitchellh.ghostty</string>`;

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

		let extracted = false;
		fsExistsSyncMock.mockImplementation((p: unknown) => {
			const ps = String(p);
			if (extracted && ps.includes("Info.plist")) return true;
			if (extracted && ps.includes("Ghostty.app")) return true;
			return false;
		});

		fsReadFileSyncMock.mockImplementation(() => plistContent);

		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				extracted = true;
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const logger = createMockLogger();
		const mgr = new BinaryManager(logger as never);
		mgr.installPath = "/tmp/test-ghostty/Ghostty.app";

		await mgr.downloadRelease(tag);

		// Should have logged a warning about missing sha256
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe("BinaryManager.getReleaseByTag", () => {
	beforeEach(makeFsSetup());

	test("fetches release by specific tag", async () => {
		const release = createMockRelease("cc-v1.0.0");
		const fetchedUrls: string[] = [];

		setFetchMock((url: unknown) => {
			fetchedUrls.push(String(url));
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve(release),
			});
		});

		const mgr = new BinaryManager(createMockLogger() as never);
		const result = await mgr.getReleaseByTag("cc-v1.0.0");

		expect(result.tag_name).toBe("cc-v1.0.0");
		expect(fetchedUrls[0]).toContain("/releases/tags/cc-v1.0.0");
	});

	test("throws on non-ok API response", async () => {
		setFetchMock(() =>
			Promise.resolve({
				ok: false,
				status: 403,
				statusText: "Forbidden",
			}),
		);

		const mgr = new BinaryManager(createMockLogger() as never);
		await expect(mgr.getReleaseByTag("cc-v1.0.0")).rejects.toThrow(
			"GitHub API returned 403",
		);
	});
});

describe("BinaryManager authentication", () => {
	beforeEach(makeFsSetup());

	test("includes auth header when token is available", async () => {
		const release = createMockRelease("cc-v1.0.0");
		const capturedHeaders: Record<string, string>[] = [];

		// Subclass to inject a known token
		class AuthTestManager extends BinaryManager {
			protected override async getGitHubToken(): Promise<string | undefined> {
				return "ghp_test_token_123";
			}
		}

		setFetchMock((_url: unknown, init: unknown) => {
			const opts = init as { headers?: Record<string, string> };
			if (opts?.headers) {
				capturedHeaders.push({ ...opts.headers });
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve(release),
			});
		});

		const mgr = new AuthTestManager(createMockLogger() as never);
		await mgr.getLatestRelease();

		expect(capturedHeaders.length).toBeGreaterThan(0);
		expect(capturedHeaders[0]?.["Authorization"]).toBe(
			"Bearer ghp_test_token_123",
		);
	});

	test("omits auth header when no token is available", async () => {
		const release = createMockRelease("cc-v1.0.0");
		const capturedHeaders: Record<string, string>[] = [];

		// Subclass to ensure no token
		class NoAuthTestManager extends BinaryManager {
			protected override async getGitHubToken(): Promise<string | undefined> {
				return undefined;
			}
		}

		setFetchMock((_url: unknown, init: unknown) => {
			const opts = init as { headers?: Record<string, string> };
			if (opts?.headers) {
				capturedHeaders.push({ ...opts.headers });
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve(release),
			});
		});

		const mgr = new NoAuthTestManager(createMockLogger() as never);
		await mgr.getLatestRelease();

		expect(capturedHeaders.length).toBeGreaterThan(0);
		expect(capturedHeaders[0]?.["Authorization"]).toBeUndefined();
	});
});
