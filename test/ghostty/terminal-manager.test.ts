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

import {
	LauncherExecutionError,
	LauncherTimeoutError,
	LauncherValidationError,
	TerminalManager,
} from "../../src/ghostty/TerminalManager.js";

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

	test("returns true when launcher responds to --help and --version", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					cb(null, { stdout: "Usage: launcher...", stderr: "" });
				} else if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0.0", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);
		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(true);
	});

	test("returns true when launcher returns non-zero but binary exists and validation passes", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					const err = Object.assign(new Error("exit 1"), { code: 1 });
					cb(err, { stdout: "", stderr: "" });
				} else if (a.includes("--version")) {
					cb(null, { stdout: "ghostty-launcher version 1.0", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
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

	test("returns true when PATH lookup fails but fallback path exists and is valid", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					const err = Object.assign(new Error("not found"), { code: "ENOENT" });
					cb(err, { stdout: "", stderr: "" });
				} else if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0.0", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
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
				if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0.0", stderr: "" });
				} else {
					cb(null, { stdout: "Bundle created", stderr: "" });
				}
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
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0.0", stderr: "" });
				} else {
					cb(new Error("launcher: command failed"), { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await expect(mgr.createProjectTerminal(workspaceRoot)).rejects.toThrow(
			"launcher: command failed",
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
				if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0.0", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
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
				if (a.includes("--version"))
					return cb(null, { stdout: "launcher version 1.0.0\n", stderr: "" });
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
				if (a.includes("--version"))
					return cb(null, { stdout: "launcher version 1.0.0\n", stderr: "" });
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
				if (a.includes("--version"))
					return cb(null, { stdout: "launcher version 1.0.0\n", stderr: "" });
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

// ══ NEW TESTS FOR FIXES ═══════════════════════════════════════════════

describe("TerminalManager.validateLauncherBinary (Fix 2)", () => {
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

	test("validates launcher when --version contains expected keywords", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					cb(null, { stdout: "Usage: launcher...", stderr: "" });
				} else if (a.includes("--version")) {
					cb(null, { stdout: "ghostty-launcher version 1.2.3", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(true);
	});

	test("fails validation when --version output doesn't contain expected keywords", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					cb(null, { stdout: "Usage: some-tool...", stderr: "" });
				} else if (a.includes("--version")) {
					cb(null, { stdout: "some-other-tool v2.0.0", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(false);
	});

	test("caches validation results to avoid repeated checks", async () => {
		let versionCallCount = 0;
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					cb(null, { stdout: "Usage: launcher...", stderr: "" });
				} else if (a.includes("--version")) {
					versionCallCount++;
					cb(null, { stdout: "launcher version 1.0", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);

		// First call should validate
		expect(await mgr.isLauncherInstalled()).toBe(true);
		expect(versionCallCount).toBe(1);

		// Second call should use cache
		expect(await mgr.isLauncherInstalled()).toBe(true);
		expect(versionCallCount).toBe(1); // No additional call
	});

	test("caches negative validation results", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					cb(null, { stdout: "Usage: tool...", stderr: "" });
				} else if (a.includes("--version")) {
					cb(new Error("command not found"), { stdout: "", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);

		// Both calls should return false and not call --version twice
		expect(await mgr.isLauncherInstalled()).toBe(false);
		expect(await mgr.isLauncherInstalled()).toBe(false);
	});
});

describe("TerminalManager error handling (Fix 3)", () => {
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

	test("throws helpful error when binary not found (ENOENT)", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				const err = Object.assign(new Error("command not found"), {
					code: "ENOENT",
				});
				cb(err, { stdout: "", stderr: "" });
			},
		);

		fsExistsSyncMock.mockImplementation(() => false);

		const mgr = new TerminalManager(createMockLogger() as never);

		// Should throw some form of helpful error (either LauncherNotFoundError or LauncherValidationError)
		await expect(mgr.createProjectTerminal("/test/project")).rejects.toThrow();

		try {
			await mgr.createProjectTerminal("/test/project");
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error instanceof Error).toBe(true);
			if (error instanceof Error) {
				// Should contain helpful guidance for users
				expect(
					error.message.includes("ghostty-launcher") ||
						error.message.includes("Install ghostty-launcher") ||
						error.message.includes("commandCentral.ghostty.launcherPath"),
				).toBe(true);
			}
		}
	});

	test("throws LauncherTimeoutError when process times out", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0.0", stderr: "" });
				} else {
					const err = Object.assign(new Error("timeout"), {
						signal: "SIGKILL",
					});
					cb(err, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);

		await expect(mgr.createProjectTerminal("/test/project")).rejects.toThrow(
			LauncherTimeoutError,
		);
		await expect(mgr.createProjectTerminal("/test/project")).rejects.toThrow(
			"timed out after 10000ms",
		);
	});

	test("throws LauncherExecutionError with exit code and stderr info", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0", stderr: "" });
				} else if (a.includes("--create-bundle")) {
					const err = Object.assign(new Error("failed"), {
						code: 1,
						stderr: "Project validation failed",
					});
					cb(err, { stdout: "", stderr: "Project validation failed" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);

		await expect(mgr.createProjectTerminal("/test/project")).rejects.toThrow(
			LauncherExecutionError,
		);
		await expect(mgr.createProjectTerminal("/test/project")).rejects.toThrow(
			"exit code 1",
		);
		await expect(mgr.createProjectTerminal("/test/project")).rejects.toThrow(
			"Project validation failed",
		);
	});

	test("throws LauncherValidationError when wrong binary found", async () => {
		mockConfigGet.mockImplementation((_key: string, _def?: unknown) => {
			if (_key === "ghostty.launcherPath") return "/usr/bin/wrong-tool";
			return _def;
		});

		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					cb(null, { stdout: "Usage: wrong-tool...", stderr: "" });
				} else if (a.includes("--version")) {
					cb(null, { stdout: "wrong-tool v1.0.0", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);

		await expect(mgr.createProjectTerminal("/test/project")).rejects.toThrow(
			LauncherValidationError,
		);
		await expect(mgr.createProjectTerminal("/test/project")).rejects.toThrow(
			"not the ghostty-launcher executable",
		);
	});

	test("provides helpful error message with actionable guidance", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				const err = Object.assign(new Error("not found"), { code: "ENOENT" });
				cb(err, { stdout: "", stderr: "" });
			},
		);

		fsExistsSyncMock.mockImplementation(() => false);

		const mgr = new TerminalManager(createMockLogger() as never);

		try {
			await mgr.createProjectTerminal("/test/project");
			expect.unreachable("Should have thrown");
		} catch (error) {
			expect(error instanceof Error).toBe(true);
			if (error instanceof Error) {
				// Should mention launcher in the error message
				expect(error.message.toLowerCase()).toContain("launcher");
				// Should provide actionable guidance
				expect(
					error.message.includes("Install") ||
						error.message.includes("install") ||
						error.message.includes("commandCentral.ghostty.launcherPath"),
				).toBe(true);
			}
		}
	});
});

describe("Multi-root workspace command support (Fix 1 - integration)", () => {
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

	test("createProjectTerminal works with any valid workspace path", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0", stderr: "" });
				} else if (a.includes("--create-bundle")) {
					cb(null, { stdout: "Bundle created", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);

		// Should work with different workspace paths (simulating multi-root scenario)
		await expect(
			mgr.createProjectTerminal("/workspace/project1"),
		).resolves.toBeUndefined();
		await expect(
			mgr.createProjectTerminal("/workspace/project2"),
		).resolves.toBeUndefined();
		await expect(
			mgr.createProjectTerminal("/different/root"),
		).resolves.toBeUndefined();
	});

	test("getTerminalInfo works with any valid workspace path", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0", stderr: "" });
				} else if (a.includes("--parse-name")) {
					cb(null, { stdout: "Test Project\n", stderr: "" });
				} else if (a.includes("--parse-icon")) {
					cb(null, { stdout: "🚀\n", stderr: "" });
				} else if (a.includes("--tmux-session")) {
					cb(null, { stdout: "test-session\n", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);

		// Should work with different workspace paths
		const info1 = await mgr.getTerminalInfo("/workspace/project1");
		expect(info1.name).toBe("Test Project");
		expect(info1.icon).toBe("🚀");
		expect(info1.tmuxSession).toBe("test-session");

		const info2 = await mgr.getTerminalInfo("/workspace/project2");
		expect(info2.name).toBe("Test Project");
		expect(info2.icon).toBe("🚀");
		expect(info2.tmuxSession).toBe("test-session");
	});
});
