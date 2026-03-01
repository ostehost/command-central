/**
 * TerminalManager Tests
 *
 * Tests launcher path resolution, isLauncherInstalled, createProjectTerminal,
 * and getTerminalInfo using mocked child_process and fs.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── VS Code mock must be set up before importing the module under test ──

// Minimal vscode mock needed by TerminalManager (uses getConfiguration)
const mockConfigGet = mock((_key: string, _default?: unknown) => _default);
const mockGetConfiguration = mock(() => ({ get: mockConfigGet }));

mock.module("vscode", () => ({
	workspace: {
		getConfiguration: mockGetConfiguration,
	},
}));

// ── child_process mock ────────────────────────────────────────────────

type ExecFileArgs = [string, string[], { timeout?: number }];

type ExecFileCallback = (
	err: Error | null,
	result: { stdout: string; stderr: string },
) => void;

// We mock 'node:child_process' to avoid real subprocesses
const execFileMock = mock(
	(
		_file: string,
		_args: string[],
		_opts: { timeout?: number },
		callback: ExecFileCallback,
	) => {
		callback(null, { stdout: "", stderr: "" });
	},
);

mock.module("node:child_process", () => ({
	execFile: execFileMock,
}));

// ── fs mock ───────────────────────────────────────────────────────────

const fsExistsSyncMock = mock((_p: string) => false);

mock.module("node:fs", () => ({
	existsSync: fsExistsSyncMock,
}));

// ── Import after mocks ────────────────────────────────────────────────

import { TerminalManager } from "../../src/ghostty/TerminalManager.js";

// ── Logger mock ───────────────────────────────────────────────────────

function createMockLogger() {
	return {
		debug: mock(),
		info: mock(),
		warn: mock(),
		error: mock(),
	};
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("TerminalManager.getLauncherPath", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
		}));
		mock.module("node:child_process", () => ({ execFile: execFileMock }));
		mock.module("node:fs", () => ({ existsSync: fsExistsSyncMock }));
	});

	test("returns configured path when set", () => {
		mockConfigGet.mockImplementation((_key: string, _def?: unknown) => {
			if (_key === "ghostty.launcherPath") return "/custom/path/launcher";
			return _def;
		});
		const mgr = new TerminalManager(createMockLogger() as never);
		expect(mgr.getLauncherPath()).toBe("/custom/path/launcher");
	});

	test("returns 'launcher' when config is empty string", () => {
		mockConfigGet.mockImplementation((_key: string, _def?: unknown) => {
			if (_key === "ghostty.launcherPath") return "";
			return _def;
		});
		const mgr = new TerminalManager(createMockLogger() as never);
		expect(mgr.getLauncherPath()).toBe("launcher");
	});

	test("returns 'launcher' when config is whitespace", () => {
		mockConfigGet.mockImplementation((_key: string, _def?: unknown) => {
			if (_key === "ghostty.launcherPath") return "   ";
			return _def;
		});
		const mgr = new TerminalManager(createMockLogger() as never);
		expect(mgr.getLauncherPath()).toBe("launcher");
	});

	test("returns 'launcher' when config is undefined", () => {
		mockConfigGet.mockImplementation(() => undefined);
		const mgr = new TerminalManager(createMockLogger() as never);
		expect(mgr.getLauncherPath()).toBe("launcher");
	});
});

describe("TerminalManager.isLauncherInstalled", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
		}));
		mock.module("node:child_process", () => ({ execFile: execFileMock }));
		mock.module("node:fs", () => ({ existsSync: fsExistsSyncMock }));
		// Default: configured path is "launcher"
		mockConfigGet.mockImplementation(() => undefined);
	});

	test("returns true when launcher responds to --help", async () => {
		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				cb(null, { stdout: "Usage: launcher...", stderr: "" });
			},
		);
		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(true);
	});

	test("returns true when launcher returns non-zero but binary exists (non-ENOENT error)", async () => {
		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				const err = Object.assign(new Error("exit 1"), { code: 1 });
				cb(err, { stdout: "", stderr: "" });
			},
		);
		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(true);
	});

	test("returns false when launcher not in PATH (ENOENT) but no fallback exists", async () => {
		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				const err = Object.assign(new Error("not found"), { code: "ENOENT" });
				cb(err, { stdout: "", stderr: "" });
			},
		);
		fsExistsSyncMock.mockImplementation(() => false);
		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(false);
	});

	test("returns true when PATH lookup fails but fallback path exists", async () => {
		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				const err = Object.assign(new Error("not found"), { code: "ENOENT" });
				cb(err, { stdout: "", stderr: "" });
			},
		);
		// Simulate fallback path existing
		fsExistsSyncMock.mockImplementation(() => true);
		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(true);
	});
});

describe("TerminalManager.createProjectTerminal", () => {
	const workspaceRoot = "/Users/test/my-project";

	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
		}));
		mock.module("node:child_process", () => ({ execFile: execFileMock }));
		mock.module("node:fs", () => ({ existsSync: fsExistsSyncMock }));
		mockConfigGet.mockImplementation(() => undefined);
		fsExistsSyncMock.mockImplementation(() => false);
	});

	test("calls launcher with --create-bundle and workspace root", async () => {
		const calls: ExecFileArgs[] = [];

		execFileMock.mockImplementation(
			(
				f: string,
				a: string[],
				o: { timeout?: number },
				cb: ExecFileCallback,
			) => {
				calls.push([f, a, o]);
				cb(null, { stdout: "Bundle created", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await mgr.createProjectTerminal(workspaceRoot);

		// The call that matters: --create-bundle <dir>
		const createCall = calls.find((c) => c[1].includes("--create-bundle"));
		expect(createCall).toBeDefined();
		expect(createCall?.[1]).toContain("--create-bundle");
		expect(createCall?.[1]).toContain(workspaceRoot);
	});

	test("throws when launcher exits with error", async () => {
		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
				cb(new Error("launcher: command failed"), { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await expect(mgr.createProjectTerminal(workspaceRoot)).rejects.toThrow(
			"launcher --create-bundle failed",
		);
	});

	test("uses configured launcher path", async () => {
		const configuredPath = "/opt/custom/launcher";
		mockConfigGet.mockImplementation((_key: string, _def?: unknown) => {
			if (_key === "ghostty.launcherPath") return configuredPath;
			return _def;
		});

		const calls: ExecFileArgs[] = [];
		execFileMock.mockImplementation(
			(
				f: string,
				a: string[],
				o: { timeout?: number },
				cb: ExecFileCallback,
			) => {
				calls.push([f, a, o]);
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await mgr.createProjectTerminal(workspaceRoot);

		const createCall = calls.find((c) => c[1].includes("--create-bundle"));
		expect(createCall?.[0]).toBe(configuredPath);
	});
});

describe("TerminalManager.getTerminalInfo", () => {
	const workspaceRoot = "/Users/test/my-project";

	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
		}));
		mock.module("node:child_process", () => ({ execFile: execFileMock }));
		mock.module("node:fs", () => ({ existsSync: fsExistsSyncMock }));
		mockConfigGet.mockImplementation(() => undefined);
		fsExistsSyncMock.mockImplementation(() => false);
	});

	test("returns name, icon, tmuxSession from launcher output", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--parse-name"))
					return cb(null, { stdout: "My Project\n", stderr: "" });
				if (a.includes("--parse-icon"))
					return cb(null, { stdout: "🚀\n", stderr: "" });
				if (a.includes("--tmux-session"))
					return cb(null, { stdout: "agent-my-project\n", stderr: "" });
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		const info = await mgr.getTerminalInfo(workspaceRoot);

		expect(info.name).toBe("My Project");
		expect(info.icon).toBe("🚀");
		expect(info.tmuxSession).toBe("agent-my-project");
	});

	test("falls back to basename when --parse-name fails", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--parse-name"))
					return cb(new Error("failed"), { stdout: "", stderr: "" });
				if (a.includes("--parse-icon"))
					return cb(null, { stdout: "📦\n", stderr: "" });
				if (a.includes("--tmux-session"))
					return cb(null, { stdout: "s1\n", stderr: "" });
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		const info = await mgr.getTerminalInfo(workspaceRoot);

		expect(info.name).toBe("my-project"); // path.basename fallback
	});

	test("returns empty strings when icon and tmux lookups fail", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--parse-name"))
					return cb(null, { stdout: "Proj\n", stderr: "" });
				cb(new Error("failed"), { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		const info = await mgr.getTerminalInfo(workspaceRoot);

		expect(info.name).toBe("Proj");
		expect(info.icon).toBe("");
		expect(info.tmuxSession).toBe("");
	});
});
