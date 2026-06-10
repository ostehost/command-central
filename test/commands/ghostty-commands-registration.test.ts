/**
 * Registration-shape test for the ghostty activation module.
 *
 * Encodes the extraction contract for
 * src/activation/register-ghostty-commands.ts: the exact command-ID set
 * (each contributed in package.json), one disposable per command, and
 * real-handler delegation through the lazy getter deps — TerminalManager
 * and BinaryManager are resettable module state in extension.ts, so the
 * handlers must re-resolve the getters on every invocation and degrade to
 * a graceful no-op while a manager is missing.
 *
 * Supersedes the former ghostty-create-terminal.test.ts, which re-simulated
 * the createTerminal handler inline; the workspace-folder scenarios below
 * run against the real handler instead.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import packageJson from "../../package.json";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

const { registerGhosttyCommands } = await import(
	"../../src/activation/register-ghostty-commands.js"
);
type GhosttyCommandDeps = Parameters<typeof registerGhosttyCommands>[0];

const EXPECTED_COMMAND_IDS = [
	"commandCentral.ghostty.createTerminal",
	"commandCentral.ghostty.checkBinary",
];

describe("registerGhosttyCommands", () => {
	let registered: Map<string, (...args: unknown[]) => unknown>;
	let terminalManager:
		| { runInProjectTerminal: ReturnType<typeof mock> }
		| undefined;
	let binaryManager:
		| {
				isInstalled: ReturnType<typeof mock>;
				getVersion: ReturnType<typeof mock>;
				getLatestRelease: ReturnType<typeof mock>;
				downloadRelease: ReturnType<typeof mock>;
		  }
		| undefined;
	let logger: { error: ReturnType<typeof mock> };
	let deps: GhosttyCommandDeps;

	beforeEach(() => {
		registered = new Map();
		vscodeMock.commands.registerCommand = mock(
			(id: string, handler: (...args: unknown[]) => unknown) => {
				registered.set(id, handler);
				return { dispose: mock() };
			},
		);
		vscodeMock.window.showErrorMessage = mock();
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showQuickPick = mock(() =>
			Promise.resolve(undefined),
		) as unknown as typeof vscodeMock.window.showQuickPick;
		vscodeMock.window.withProgress = mock(
			(
				_options: unknown,
				task: (
					progress: { report: (value: unknown) => void },
					token: { isCancellationRequested: boolean },
				) => Promise<unknown>,
			) => task({ report: mock() }, { isCancellationRequested: false }),
		);
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/mock/workspace" }, name: "workspace", index: 0 },
		];
		terminalManager = undefined;
		binaryManager = undefined;
		logger = { error: mock() };
		deps = {
			getTerminalManager: () => terminalManager,
			getBinaryManager: () => binaryManager,
			logger,
		} as unknown as GhosttyCommandDeps;
	});

	function handler(id: string): (...args: unknown[]) => unknown {
		const h = registered.get(id);
		if (!h) throw new Error(`Command not registered: ${id}`);
		return h;
	}

	function installedBinaryManager(overrides?: {
		latestTag?: string;
		bundleVersion?: string | null;
	}) {
		return {
			isInstalled: mock(() => Promise.resolve(true)),
			getVersion: mock(() =>
				Promise.resolve({
					bundleVersion: overrides?.bundleVersion ?? "v1.2.3",
					commitHash: "abcdef1234567890",
				}),
			),
			getLatestRelease: mock(() =>
				Promise.resolve({ tag_name: overrides?.latestTag ?? "v1.2.3" }),
			),
			downloadRelease: mock(() => Promise.resolve()),
		};
	}

	test("registers exactly the ghostty command IDs, in order, one disposable each", () => {
		const disposables = registerGhosttyCommands(deps);

		expect([...registered.keys()]).toEqual(EXPECTED_COMMAND_IDS);
		expect(disposables).toHaveLength(EXPECTED_COMMAND_IDS.length);
		for (const disposable of disposables) {
			expect(typeof disposable.dispose).toBe("function");
		}
	});

	test("every registered command is contributed in package.json", () => {
		registerGhosttyCommands(deps);

		const contributed = packageJson.contributes.commands.map(
			(c: { command: string }) => c.command,
		);
		for (const id of registered.keys()) {
			expect(contributed).toContain(id);
		}
	});

	test("createTerminal shows error when no workspace folders are open", async () => {
		vscodeMock.workspace.workspaceFolders = [];
		terminalManager = { runInProjectTerminal: mock(() => Promise.resolve()) };
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.createTerminal")();

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Command Central: No workspace folder open.",
		);
		expect(terminalManager.runInProjectTerminal).not.toHaveBeenCalled();
	});

	test("createTerminal routes through runInProjectTerminal for single-root workspace", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/Users/test/project-a" }, name: "project-a", index: 0 },
		];
		terminalManager = { runInProjectTerminal: mock(() => Promise.resolve()) };
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.createTerminal")();

		expect(terminalManager.runInProjectTerminal).toHaveBeenCalledWith(
			"/Users/test/project-a",
		);
		expect(vscodeMock.window.showQuickPick).not.toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Command Central: Project terminal opened for project-a.",
		);
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
	});

	test("createTerminal multi-root picker uses selected workspace folder", async () => {
		const folderB = {
			uri: { fsPath: "/Users/test/project-b" },
			name: "project-b",
			index: 1,
		};
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/Users/test/project-a" }, name: "project-a", index: 0 },
			folderB,
		];
		vscodeMock.window.showQuickPick = mock(() =>
			Promise.resolve({
				label: folderB.name,
				description: folderB.uri.fsPath,
				folder: folderB,
			}),
		) as unknown as typeof vscodeMock.window.showQuickPick;
		terminalManager = { runInProjectTerminal: mock(() => Promise.resolve()) };
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.createTerminal")();

		expect(terminalManager.runInProjectTerminal).toHaveBeenCalledWith(
			"/Users/test/project-b",
		);
	});

	test("createTerminal picker cancel exits without opening terminal", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/Users/test/project-a" }, name: "project-a", index: 0 },
			{ uri: { fsPath: "/Users/test/project-b" }, name: "project-b", index: 1 },
		];
		terminalManager = { runInProjectTerminal: mock(() => Promise.resolve()) };
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.createTerminal")();

		expect(terminalManager.runInProjectTerminal).not.toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("createTerminal surfaces runInProjectTerminal failures", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/Users/test/project-a" }, name: "project-a", index: 0 },
		];
		terminalManager = {
			runInProjectTerminal: mock(() =>
				Promise.reject(new Error("launcher exploded")),
			),
		};
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.createTerminal")();

		expect(logger.error).toHaveBeenCalledWith(
			"Failed to open project terminal",
			expect.any(Error),
		);
		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Command Central: Failed to open terminal — launcher exploded",
		);
	});

	test("createTerminal resolves the terminal manager lazily — late-binding contract", async () => {
		// Registration happens while terminalManager is still undefined in
		// extension.ts module state; the handler must re-resolve the getter on
		// every invocation rather than freezing the registration-time value.
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.createTerminal")();
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();

		terminalManager = { runInProjectTerminal: mock(() => Promise.resolve()) };
		await handler("commandCentral.ghostty.createTerminal")();

		expect(terminalManager.runInProjectTerminal).toHaveBeenCalledWith(
			"/mock/workspace",
		);
	});

	test("checkBinary is a graceful no-op while binaryManager is missing", async () => {
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.checkBinary")();

		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("checkBinary reports installed binary and stops on OK", async () => {
		binaryManager = installedBinaryManager();
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve("OK"),
		);
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.checkBinary")();

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Command Central: Ghostty CC v1.2.3 (abcdef12) is installed.",
			"Check for Updates",
			"OK",
		);
		expect(binaryManager.getLatestRelease).not.toHaveBeenCalled();
		expect(binaryManager.downloadRelease).not.toHaveBeenCalled();
	});

	test("checkBinary reports already up to date after update check", async () => {
		binaryManager = installedBinaryManager({ latestTag: "v1.2.3" });
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve("Check for Updates"),
		);
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.checkBinary")();

		expect(binaryManager.getLatestRelease).toHaveBeenCalledTimes(1);
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Command Central: Ghostty is already up to date (v1.2.3).",
		);
		expect(binaryManager.downloadRelease).not.toHaveBeenCalled();
	});

	test("checkBinary installs an available release when not yet installed", async () => {
		binaryManager = {
			isInstalled: mock(() => Promise.resolve(false)),
			getVersion: mock(() =>
				Promise.resolve({ bundleVersion: null, commitHash: null }),
			),
			getLatestRelease: mock(() => Promise.resolve({ tag_name: "v2.0.0" })),
			downloadRelease: mock(() => Promise.resolve()),
		};
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve("Install"),
		);
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.checkBinary")();

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Command Central: Ghostty v2.0.0 is available.",
			"Install",
			"Cancel",
		);
		expect(binaryManager.downloadRelease).toHaveBeenCalledWith("v2.0.0");
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Command Central: Ghostty v2.0.0 installed successfully.",
		);
		// getVersion is skipped entirely on the not-installed path
		expect(binaryManager.getVersion).not.toHaveBeenCalled();
	});

	test("checkBinary declines installation on Cancel", async () => {
		binaryManager = {
			isInstalled: mock(() => Promise.resolve(false)),
			getVersion: mock(() =>
				Promise.resolve({ bundleVersion: null, commitHash: null }),
			),
			getLatestRelease: mock(() => Promise.resolve({ tag_name: "v2.0.0" })),
			downloadRelease: mock(() => Promise.resolve()),
		};
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve("Cancel"),
		);
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.checkBinary")();

		expect(binaryManager.downloadRelease).not.toHaveBeenCalled();
	});

	test("checkBinary surfaces failures via logger and error message", async () => {
		binaryManager = {
			isInstalled: mock(() => Promise.reject(new Error("network down"))),
			getVersion: mock(),
			getLatestRelease: mock(),
			downloadRelease: mock(),
		};
		registerGhosttyCommands(deps);

		await handler("commandCentral.ghostty.checkBinary")();

		expect(logger.error).toHaveBeenCalledWith(
			"Ghostty binary check failed",
			expect.any(Error),
		);
		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Command Central: Ghostty check failed — network down",
		);
	});
});
