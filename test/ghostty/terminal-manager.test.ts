/**
 * TerminalManager Tests
 *
 * Tests launcher path resolution, isLauncherInstalled, createProjectTerminal,
 * and getTerminalInfo using mocked child_process and fs.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

import * as os from "node:os";
import * as path from "node:path";

// ── VS Code mock must be set up before importing the module under test ──

// Minimal vscode mock needed by TerminalManager (uses getConfiguration)
const mockConfigGet = mock((_key: string, _default?: unknown) => _default);
const mockGetConfiguration = mock(() => ({ get: mockConfigGet }));
const mockTerminalSendText = mock((_text: string) => {});
const mockTerminalShow = mock(() => {});
const mockCreateTerminal = mock((_options?: unknown) => ({
	sendText: mockTerminalSendText,
	show: mockTerminalShow,
	hide: mock(),
	dispose: mock(),
}));

// Used by `promptIntegratedTerminalFallback` — controls the user's choice
// in the fallback warning toast. Tests override this per-case.
const mockShowWarningMessage = mock(
	async (..._args: unknown[]): Promise<string | undefined> => undefined,
);
const mockOpenExternal = mock(async (_uri: unknown) => true);

mock.module("vscode", () => ({
	workspace: {
		getConfiguration: mockGetConfiguration,
	},
	window: {
		createTerminal: mockCreateTerminal,
		showWarningMessage: mockShowWarningMessage,
	},
	env: {
		openExternal: mockOpenExternal,
	},
	Uri: {
		parse: (s: string) => ({ toString: () => s }),
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
	...realChildProcess,
	execFile: execFileMock,
}));

// ── fs mock ───────────────────────────────────────────────────────────

const fsExistsSyncMock = mock((_p: string) => false);
const fsAccessSyncMock = mock((_p: string, _mode?: number) => undefined);

mock.module("node:fs", () => ({
	...realFs,
	promises: realFs.promises,
	existsSync: fsExistsSyncMock,
	accessSync: fsAccessSyncMock,
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

function createMockGlobalState(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		get: mock((key: string) => store.get(key)),
		update: mock(async (key: string, value: string | undefined) => {
			if (typeof value === "undefined") {
				store.delete(key);
				return;
			}
			store.set(key, value);
		}),
		_store: store,
	};
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("TerminalManager.getLauncherPath", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
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

	test("returns cached auto-detected path when config is unset", () => {
		mockConfigGet.mockImplementation(() => undefined);
		const globalState = createMockGlobalState({
			"commandCentral.ghostty.autoDetectedLauncherPath":
				"/Users/test/projects/ghostty-launcher/launcher",
		});
		const mgr = new TerminalManager(
			createMockLogger() as never,
			undefined,
			globalState as never,
		);
		expect(mgr.getLauncherPath()).toBe(
			"/Users/test/projects/ghostty-launcher/launcher",
		);
	});
});

describe("TerminalManager.resolveLauncherHelperScriptPath", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
	});

	test("anchors helper scripts to configured launcher binary", async () => {
		const launcherPath = "/Users/test/projects/ghostty-launcher/launcher";
		const helperPath =
			"/Users/test/projects/ghostty-launcher/scripts/oste-capture.sh";

		mockConfigGet.mockImplementation((_key: string, _def?: unknown) => {
			if (_key === "ghostty.launcherPath") return launcherPath;
			return _def;
		});
		fsExistsSyncMock.mockImplementation(
			(p: string) => p === launcherPath || p === helperPath,
		);
		execFileMock.mockImplementation(
			(f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (f === launcherPath && a.includes("--help")) {
					cb(null, { stdout: "Usage: launcher", stderr: "" });
					return;
				}
				if (f === launcherPath && a.includes("--version")) {
					cb(null, { stdout: "ghostty-launcher version 1.2.3", stderr: "" });
					return;
				}
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await expect(
			mgr.resolveLauncherHelperScriptPath("oste-capture.sh"),
		).resolves.toBe(helperPath);
	});

	test("resolves PATH launcher before anchoring helper scripts", async () => {
		const originalPath = process.env["PATH"];
		const launcherDir = "/Users/test/projects/ghostty-launcher";
		const launcherPath = `${launcherDir}/launcher`;
		const helperPath = `${launcherDir}/scripts/oste-kill.sh`;

		try {
			process.env["PATH"] = `${launcherDir}:/usr/bin`;
			mockConfigGet.mockImplementation((_key: string, _def?: unknown) => {
				if (_key === "ghostty.launcherPath") return "";
				return _def;
			});
			fsExistsSyncMock.mockImplementation(
				(p: string) => p === launcherPath || p === helperPath,
			);
			execFileMock.mockImplementation(
				(f: string, a: string[], _o: object, cb: ExecFileCallback) => {
					if (f === launcherPath && a.includes("--help")) {
						cb(null, { stdout: "Usage: launcher", stderr: "" });
						return;
					}
					if (f === launcherPath && a.includes("--version")) {
						cb(null, { stdout: "ghostty-launcher version 1.2.3", stderr: "" });
						return;
					}
					const err = Object.assign(new Error("not found"), { code: "ENOENT" });
					cb(err, { stdout: "", stderr: "" });
				},
			);

			const mgr = new TerminalManager(createMockLogger() as never);
			await expect(
				mgr.resolveLauncherHelperScriptPath("oste-kill.sh"),
			).resolves.toBe(helperPath);
		} finally {
			process.env["PATH"] = originalPath;
		}
	});
});

describe("TerminalManager.isLauncherInstalled", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
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

	test("checks common local fallback launcher path", async () => {
		const fallbackPath = path.join(
			os.homedir(),
			"projects",
			"ghostty-launcher",
			"launcher",
		);
		const calls: Array<{ file: string; args: string[] }> = [];

		execFileMock.mockImplementation(
			(f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				calls.push({ file: f, args: a });
				if (f === "launcher" && a.includes("--help")) {
					const err = Object.assign(new Error("not found"), { code: "ENOENT" });
					cb(err, { stdout: "", stderr: "" });
					return;
				}
				if (f === fallbackPath && a.includes("--version")) {
					cb(null, { stdout: "ghostty-launcher version 1.2.3", stderr: "" });
					return;
				}
				const err = Object.assign(new Error("not found"), { code: "ENOENT" });
				cb(err, { stdout: "", stderr: "" });
			},
		);
		fsExistsSyncMock.mockImplementation((p: string) => p === fallbackPath);

		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(true);
		expect(
			calls.some(
				(call) => call.file === fallbackPath && call.args.includes("--version"),
			),
		).toBe(true);
	});
});

describe("TerminalManager.createProjectTerminal", () => {
	const workspaceRoot = "/Users/test/my-project";

	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
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
		fsExistsSyncMock.mockImplementation((p: string) => p === configuredPath);

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

	test("falls through an invalid default PATH launcher to a valid fallback path", async () => {
		const originalPath = process.env["PATH"];
		const pathLauncher = "/mock/bin/launcher";
		const fallbackPath = path.join(
			os.homedir(),
			"projects",
			"ghostty-launcher",
			"launcher",
		);
		const globalState = createMockGlobalState();
		const calls: ExecFileArgs[] = [];

		try {
			process.env["PATH"] = `/mock/bin:/usr/bin`;
			mockConfigGet.mockImplementation(() => undefined);
			fsExistsSyncMock.mockImplementation(
				(p: string) => p === pathLauncher || p === fallbackPath,
			);
			execFileMock.mockImplementation(
				(
					f: string,
					a: string[],
					o: { timeout?: number },
					cb: ExecFileCallback,
				) => {
					calls.push([f, a, o]);
					if (f === pathLauncher && a.includes("--version")) {
						cb(null, { stdout: "wrong-tool build abc123", stderr: "" });
						return;
					}
					if (f === fallbackPath && a.includes("--version")) {
						cb(null, {
							stdout: "ghostty-launcher version 0.1.0",
							stderr: "",
						});
						return;
					}
					if (f === fallbackPath && a.includes("--create-bundle")) {
						cb(null, { stdout: "Bundle created", stderr: "" });
						return;
					}
					cb(null, { stdout: "", stderr: "" });
				},
			);

			const mgr = new TerminalManager(
				createMockLogger() as never,
				undefined,
				globalState as never,
			);
			await mgr.createProjectTerminal(workspaceRoot);

			const createCall = calls.find((c) => c[1].includes("--create-bundle"));
			expect(createCall?.[0]).toBe(fallbackPath);
			expect(globalState.update).toHaveBeenCalledWith(
				"commandCentral.ghostty.autoDetectedLauncherPath",
				fallbackPath,
			);
		} finally {
			process.env["PATH"] = originalPath;
		}
	});
});

describe("TerminalManager icon persistence before create-bundle", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
		mockConfigGet.mockImplementation(() => undefined);
		fsExistsSyncMock.mockImplementation(() => false);
	});

	test("ensures icon before direct createProjectTerminal bundle creation", async () => {
		const events: string[] = [];
		const iconEnsurer = {
			ensureProjectIconPersisted: mock(async () => {
				events.push("ensure-icon");
				return "🧪";
			}),
		};

		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0.0", stderr: "" });
				} else if (a.includes("--create-bundle")) {
					events.push("create-bundle");
					cb(null, { stdout: "Bundle created", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never, iconEnsurer);
		await mgr.createProjectTerminal("/Users/test/my-project");

		expect(events).toEqual(["ensure-icon", "create-bundle"]);
		expect(iconEnsurer.ensureProjectIconPersisted).toHaveBeenCalledTimes(1);
	});

	test("ensures icon before runInProjectTerminal path creates a bundle", async () => {
		const events: string[] = [];
		const iconEnsurer = {
			ensureProjectIconPersisted: mock(async () => {
				events.push("ensure-icon");
				return "📦";
			}),
		};

		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version")) {
					cb(null, { stdout: "launcher version 1.0.0", stderr: "" });
				} else if (a.includes("--parse-name")) {
					cb(null, { stdout: "my-project\n", stderr: "" });
				} else if (a.includes("--parse-icon")) {
					cb(null, { stdout: "📦\n", stderr: "" });
				} else if (a.includes("--session-id")) {
					cb(null, { stdout: "\n", stderr: "" });
				} else if (a.includes("--create-bundle")) {
					events.push("create-bundle");
					cb(null, { stdout: "Bundle created", stderr: "" });
				} else if (a.length === 1 && a[0] === "/Users/test/my-project") {
					events.push("open-bundle");
					cb(null, { stdout: "Bundle opened", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never, iconEnsurer);
		await mgr.runInProjectTerminal("/Users/test/my-project");

		expect(events).toEqual(["ensure-icon", "create-bundle", "open-bundle"]);
		expect(iconEnsurer.ensureProjectIconPersisted).toHaveBeenCalledTimes(1);
	});
});

describe("TerminalManager.runInProjectTerminal launch surface", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: {
				createTerminal: mockCreateTerminal,
				showWarningMessage: mockShowWarningMessage,
			},
			env: { openExternal: mockOpenExternal },
			Uri: { parse: (s: string) => ({ toString: () => s }) },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
		mockConfigGet.mockImplementation(() => undefined);
		fsExistsSyncMock.mockImplementation(() => false);
		mockShowWarningMessage.mockReset();
		mockShowWarningMessage.mockImplementation(
			async () => undefined as string | undefined,
		);
		mockCreateTerminal.mockClear();
		mockTerminalSendText.mockClear();
		mockTerminalShow.mockClear();
	});

	test("prompts before integrated terminal when launcher is unavailable; user opts in", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					const err = Object.assign(new Error("not found"), { code: "ENOENT" });
					cb(err, { stdout: "", stderr: "" });
					return;
				}
				cb(null, { stdout: "", stderr: "" });
			},
		);
		fsExistsSyncMock.mockImplementation(() => false);
		mockShowWarningMessage.mockImplementation(
			async () => "Open in VS Code Terminal",
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await mgr.runInProjectTerminal("/Users/test/my-project", "echo hi");

		expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
		expect(mockCreateTerminal).toHaveBeenCalledWith({
			name: "Terminal: my-project",
			cwd: "/Users/test/my-project",
		});
		expect(mockTerminalSendText).toHaveBeenCalledWith("echo hi");
		expect(mockTerminalShow).toHaveBeenCalled();
	});

	test("does NOT open integrated terminal when user dismisses the fallback prompt", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					const err = Object.assign(new Error("not found"), { code: "ENOENT" });
					cb(err, { stdout: "", stderr: "" });
					return;
				}
				cb(null, { stdout: "", stderr: "" });
			},
		);
		fsExistsSyncMock.mockImplementation(() => false);
		mockShowWarningMessage.mockImplementation(async () => undefined);

		const mgr = new TerminalManager(createMockLogger() as never);
		await mgr.runInProjectTerminal("/Users/test/my-project", "echo hi");

		expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
		expect(mockCreateTerminal).not.toHaveBeenCalled();
		expect(mockTerminalSendText).not.toHaveBeenCalled();
	});

	test("prompts before integrated terminal when configured launcher is invalid", async () => {
		mockConfigGet.mockImplementation((_key: string, _def?: unknown) => {
			if (_key === "ghostty.launcherPath") return "/usr/bin/wrong-tool";
			return _def;
		});
		fsExistsSyncMock.mockImplementation(
			(p: string) => p === "/usr/bin/wrong-tool",
		);
		execFileMock.mockImplementation(
			(f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (f === "/usr/bin/wrong-tool" && a.includes("--help")) {
					cb(null, { stdout: "Usage: wrong-tool", stderr: "" });
					return;
				}
				if (f === "/usr/bin/wrong-tool" && a.includes("--version")) {
					cb(null, { stdout: "wrong-tool build abc123", stderr: "" });
					return;
				}
				cb(null, { stdout: "", stderr: "" });
			},
		);
		mockShowWarningMessage.mockImplementation(
			async () => "Open in VS Code Terminal",
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await mgr.runInProjectTerminal("/Users/test/my-project", "echo hi");

		expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
		expect(mockCreateTerminal).toHaveBeenCalledWith({
			name: "Terminal: my-project",
			cwd: "/Users/test/my-project",
		});
		expect(mockTerminalSendText).toHaveBeenCalledWith("echo hi");
		expect(mockTerminalShow).toHaveBeenCalled();
	});

	test("opens existing project bundle when session exists and no command provided", async () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		execFileMock.mockImplementation(
			(f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				calls.push({ file: f, args: a });
				if (a.includes("--version"))
					return cb(null, { stdout: "launcher version 1.0.0\n", stderr: "" });
				if (a.includes("--parse-name"))
					return cb(null, { stdout: "My Project\n", stderr: "" });
				if (a.includes("--parse-icon"))
					return cb(null, { stdout: "🚀\n", stderr: "" });
				if (a.includes("--session-id"))
					return cb(null, { stdout: "agent-my-project\n", stderr: "" });
				if (a.length === 1 && a[0] === "/Users/test/my-project")
					return cb(null, { stdout: "Bundle opened\n", stderr: "" });
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await mgr.runInProjectTerminal("/Users/test/my-project");

		expect(
			calls.some(
				(c) =>
					c.file === "launcher" &&
					c.args.length === 1 &&
					c.args[0] === "/Users/test/my-project",
			),
		).toBe(true);
		expect(calls.some((c) => c.args.includes("--create-bundle"))).toBe(false);
		expect(calls.some((c) => c.file === "oste-steer.sh")).toBe(false);
	});

	// Retired with rc.31: the create-bundle → open-bundle → steer sequence
	// and the --session-id lookup-before-steer contract used to be enforced
	// here. With launcher --send (rc.31 / launcher 1.2.0+), the launcher owns
	// the entire flow internally; the extension just delegates. See the
	// "delegates send to `launcher --send ...`" test for the new contract.
});

describe("TerminalManager.getTerminalInfo", () => {
	const workspaceRoot = "/Users/test/my-project";

	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
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
				if (a.includes("--session-id"))
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
				if (a.includes("--session-id"))
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

	test("surfaces multiplexer=tmux when --parse-multiplexer returns tmux", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version"))
					return cb(null, { stdout: "launcher version 1.1.0\n", stderr: "" });
				if (a.includes("--parse-name"))
					return cb(null, { stdout: "Proj\n", stderr: "" });
				if (a.includes("--parse-icon"))
					return cb(null, { stdout: "📦\n", stderr: "" });
				if (a.includes("--session-id"))
					return cb(null, { stdout: "agent-proj\n", stderr: "" });
				if (a.includes("--parse-multiplexer"))
					return cb(null, { stdout: "tmux\n", stderr: "" });
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		const info = await mgr.getTerminalInfo(workspaceRoot);
		expect(info.multiplexer).toBe("tmux");
	});

	test("surfaces multiplexer=zellij when --parse-multiplexer returns zellij", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version"))
					return cb(null, { stdout: "launcher version 1.1.0\n", stderr: "" });
				if (a.includes("--parse-name"))
					return cb(null, { stdout: "Proj\n", stderr: "" });
				if (a.includes("--parse-icon"))
					return cb(null, { stdout: "📦\n", stderr: "" });
				if (a.includes("--session-id"))
					return cb(null, { stdout: "agent-proj\n", stderr: "" });
				if (a.includes("--parse-multiplexer"))
					return cb(null, { stdout: "zellij\n", stderr: "" });
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		const info = await mgr.getTerminalInfo(workspaceRoot);
		expect(info.multiplexer).toBe("zellij");
	});

	test("falls back to multiplexer=unknown when --parse-multiplexer unsupported", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--version"))
					return cb(null, { stdout: "launcher version 1.0.0\n", stderr: "" });
				if (a.includes("--parse-name"))
					return cb(null, { stdout: "Proj\n", stderr: "" });
				if (a.includes("--parse-icon"))
					return cb(null, { stdout: "📦\n", stderr: "" });
				if (a.includes("--session-id"))
					return cb(null, { stdout: "agent-proj\n", stderr: "" });
				if (a.includes("--parse-multiplexer"))
					return cb(new Error("unknown flag --parse-multiplexer"), {
						stdout: "",
						stderr: "",
					});
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		const info = await mgr.getTerminalInfo(workspaceRoot);
		expect(info.multiplexer).toBe("unknown");
	});
});

describe("TerminalManager.runInProjectTerminal multiplexer dispatch", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: {
				createTerminal: mockCreateTerminal,
				showWarningMessage: mockShowWarningMessage,
			},
			env: { openExternal: mockOpenExternal },
			Uri: { parse: (s: string) => ({ toString: () => s }) },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
		mockConfigGet.mockImplementation(() => undefined);
		fsExistsSyncMock.mockImplementation(() => true); // launcher present
		mockShowWarningMessage.mockReset();
		mockCreateTerminal.mockClear();
		execFileMock.mockReset();
	});

	// Retired with rc.31: previously this block had four tests asserting the
	// extension shelled out directly to `zellij` (for zellij projects) or
	// `oste-steer.sh` (for tmux projects). Those direct-dispatch paths are
	// gone — the launcher's `--send` subcommand owns multiplexer-specific
	// behavior internally. Coverage for those dispatch decisions lives in
	// `~/projects/ghostty-launcher` (launcher 1.2.0+). The single remaining
	// test below pins the new integration contract: extension delegates,
	// nothing else.

	// rc.31 contract: dispatchSteer delegates the entire "send command to
	// project session" operation to `launcher --send <dir> --command <cmd>`.
	// The launcher owns multiplexer dispatch, ZELLIJ_SOCKET_DIR, bundle open,
	// and session-alive waiting. The extension MUST NOT shell out to `zellij`
	// or `oste-steer.sh` directly anymore — that was the rc.29/rc.30 path that
	// could not reach the bundle's isolated zellij socket and could not
	// resurrect EXITED sessions. See rc.31 commit message.
	test("delegates send to `launcher --send <dir> --command <cmd>`", async () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		execFileMock.mockImplementation(
			(file: string, a: string[], _o: object, cb: ExecFileCallback) => {
				calls.push({ file, args: a });
				if (a.includes("--version"))
					return cb(null, { stdout: "launcher version 1.2.0\n", stderr: "" });
				if (a.includes("--help"))
					return cb(null, { stdout: "launcher help\n", stderr: "" });
				if (a.includes("--parse-name"))
					return cb(null, { stdout: "Config\n", stderr: "" });
				if (a.includes("--parse-icon"))
					return cb(null, { stdout: "⚙️\n", stderr: "" });
				if (a.includes("--session-id"))
					return cb(null, { stdout: "agent-config\n", stderr: "" });
				if (a.includes("--parse-multiplexer"))
					return cb(null, { stdout: "zellij\n", stderr: "" });
				// --send succeeds (launcher handles everything).
				if (a.includes("--send")) return cb(null, { stdout: "", stderr: "" });
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await mgr.runInProjectTerminal("/Users/test/config", "claude --continue");

		const sendCalls = calls.filter((c) => c.args.includes("--send"));
		const directZellijCalls = calls.filter((c) => c.file === "zellij");
		const directSteerCalls = calls.filter((c) =>
			c.file.endsWith("/oste-steer.sh"),
		);

		// At least one --send call with the right shape.
		expect(sendCalls.length).toBeGreaterThan(0);
		const sendArgs = sendCalls[0]?.args ?? [];
		expect(sendArgs).toContain("--send");
		expect(sendArgs).toContain("/Users/test/config");
		expect(sendArgs).toContain("--command");
		expect(sendArgs).toContain("claude --continue");

		// Extension MUST NOT shell out to zellij or oste-steer.sh directly.
		expect(directZellijCalls.length).toBe(0);
		expect(directSteerCalls.length).toBe(0);
	});

	// Retired with rc.31: the empty-→-zellij default lives in the launcher's
	// `--send` subcommand now (launcher.sh `parse_multiplexer` + the same
	// GHL_DEFAULT_MULTIPLEXER:-zellij cascade). The extension delegates
	// blindly; defaulting tests belong in the launcher repo.
});

// ══ NEW TESTS FOR FIXES ═══════════════════════════════════════════════

describe("TerminalManager.validateLauncherBinary (Fix 2)", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
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
					cb(null, { stdout: "some-other-tool build abc123", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(false);
	});

	test("accepts plain semver output from --version", async () => {
		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					cb(null, { stdout: "Usage: launcher...", stderr: "" });
				} else if (a.includes("--version")) {
					cb(null, { stdout: "v0.1.0", stderr: "" });
				} else {
					cb(null, { stdout: "", stderr: "" });
				}
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		expect(await mgr.isLauncherInstalled()).toBe(true);
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
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
		mockConfigGet.mockImplementation(() => undefined);
		fsExistsSyncMock.mockImplementation(() => false);
	});

	test("throws helpful error when binary not found (ENOENT)", async () => {
		execFileMock.mockImplementation(
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
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
		const wrongToolPath = "/usr/bin/wrong-tool";
		mockConfigGet.mockImplementation((_key: string, _def?: unknown) => {
			if (_key === "ghostty.launcherPath") return wrongToolPath;
			return _def;
		});
		fsExistsSyncMock.mockImplementation((p: string) => p === wrongToolPath);

		execFileMock.mockImplementation(
			(_f: string, a: string[], _o: object, cb: ExecFileCallback) => {
				if (a.includes("--help")) {
					cb(null, { stdout: "Usage: wrong-tool...", stderr: "" });
				} else if (a.includes("--version")) {
					cb(null, { stdout: "wrong-tool build abc123", stderr: "" });
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
			(_f: string, _a: string[], _o: object, cb: ExecFileCallback) => {
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
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
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
				} else if (a.includes("--session-id")) {
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

describe("TerminalManager.runInBundleTerminal", () => {
	beforeEach(() => {
		mock.restore();
		mock.module("vscode", () => ({
			workspace: { getConfiguration: mockGetConfiguration },
			window: { createTerminal: mockCreateTerminal },
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		mock.module("node:fs", () => ({
			...realFs,
			promises: realFs.promises,
			existsSync: fsExistsSyncMock,
			accessSync: fsAccessSyncMock,
		}));
		mockConfigGet.mockImplementation(() => undefined);
	});

	test("opens the bundle and injects the command via osascript", async () => {
		const bundlePath = "/Applications/Projects/test-project.app";
		fsExistsSyncMock.mockImplementation((p: string) => p === bundlePath);
		execFileMock.mockImplementation(
			(_f: string, _args: string[], _o: object, cb: ExecFileCallback) => {
				cb(null, { stdout: "", stderr: "" });
			},
		);

		const mgr = new TerminalManager(createMockLogger() as never);
		await expect(
			mgr.runInBundleTerminal(bundlePath, "claude --continue"),
		).resolves.toBeUndefined();

		expect(
			execFileMock.mock.calls.some(
				([file, args]) =>
					file === "open" && Array.isArray(args) && args.includes(bundlePath),
			),
		).toBe(true);
		expect(
			execFileMock.mock.calls.some(
				([file, args]) =>
					file === "osascript" && Array.isArray(args) && args.length === 1,
			),
		).toBe(true);
	});
});
