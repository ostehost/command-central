/**
 * Registration-shape test for the git-sort activation module.
 *
 * Encodes the extraction contract for
 * src/activation/register-git-sort-commands.ts: the exact non-slot
 * command-ID set (kept in sync with package.json contributes), one
 * disposable per command, and real-handler delegation through the lazy
 * getter deps.
 *
 * The openInIntegratedTerminal cases are the late-binding contract from the
 * modularization plan: terminalManager is constructed long after these
 * commands register, so the handler must re-resolve the getter on every
 * invocation — capturing it by value at registration time would freeze the
 * integrated-terminal fallback in place forever, silently.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import packageJson from "../../package.json";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

const { registerGitSortCommands } = await import(
	"../../src/activation/register-git-sort-commands.js"
);
type GitSortCommandDeps = Parameters<typeof registerGitSortCommands>[0];

const EXPECTED_COMMAND_IDS = [
	"commandCentral.gitSort.enable",
	"commandCentral.gitSort.disable",
	"commandCentral.gitSort.refreshView",
	"commandCentral.gitSort.changeSortOrder",
	"commandCentral.gitSort.changeFileFilter",
	"commandCentral.gitSort.openChange",
	"commandCentral.gitSort.openFile",
	"commandCentral.gitSort.openDiff",
	"commandCentral.gitSort.revealInExplorer",
	"commandCentral.gitSort.copyPath",
	"commandCentral.gitSort.copyRelativePath",
	"commandCentral.gitSort.openToSide",
	"commandCentral.gitSort.selectForCompare",
	"commandCentral.gitSort.compareWithSelected",
	"commandCentral.gitSort.revealInFinder",
	"commandCentral.gitSort.openInIntegratedTerminal",
	"commandCentral.gitSort.openWith",
	"commandCentral.gitSort.openPreview",
];

function createProviderMock() {
	return {
		refresh: mock(),
		getSortOrder: mock(() => "newest"),
		setSortOrder: mock(),
		openChange: mock(() => Promise.resolve()),
	};
}

describe("registerGitSortCommands", () => {
	let registered: Map<string, (...args: unknown[]) => unknown>;
	let gitSorter:
		| {
				enable: ReturnType<typeof mock>;
				disable: ReturnType<typeof mock>;
				activate: ReturnType<typeof mock>;
		  }
		| undefined;
	let provider: ReturnType<typeof createProviderMock>;
	let projectViewManager:
		| {
				getProviderByViewId: ReturnType<typeof mock>;
				getProviderForTreeView: ReturnType<typeof mock>;
				getAnyVisibleProvider: ReturnType<typeof mock>;
				getProviderForFile: ReturnType<typeof mock>;
		  }
		| undefined;
	let terminalManager:
		| { runInProjectTerminal: ReturnType<typeof mock> }
		| undefined;
	let logger: {
		info: ReturnType<typeof mock>;
		debug: ReturnType<typeof mock>;
		error: ReturnType<typeof mock>;
	};
	let deps: GitSortCommandDeps;

	beforeEach(() => {
		registered = new Map();
		vscodeMock.commands.registerCommand = mock(
			(id: string, handler: (...args: unknown[]) => unknown) => {
				registered.set(id, handler);
				return { dispose: mock() };
			},
		);
		vscodeMock.commands.executeCommand = mock(() => Promise.resolve());
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showErrorMessage = mock();
		vscodeMock.window.setStatusBarMessage = mock(() => ({ dispose: mock() }));
		vscodeMock.window.createTerminal = mock(() => ({
			show: mock(),
			hide: mock(),
			dispose: mock(),
			sendText: mock(),
		}));
		vscodeMock.env.clipboard.writeText = mock(() => Promise.resolve());
		gitSorter = {
			enable: mock(),
			disable: mock(),
			activate: mock(() => Promise.resolve()),
		};
		provider = createProviderMock();
		projectViewManager = {
			getProviderByViewId: mock(() => provider),
			getProviderForTreeView: mock(() => provider),
			getAnyVisibleProvider: mock(() => provider),
			getProviderForFile: mock(() => provider),
		};
		terminalManager = undefined;
		logger = { info: mock(), debug: mock(), error: mock() };
		deps = {
			getGitSorter: () => gitSorter,
			getProjectViewManager: () => projectViewManager,
			extensionFilterState: {},
			getExtensionFilterViewManager: () => undefined,
			getTerminalManager: () => terminalManager,
			logger,
		} as unknown as GitSortCommandDeps;
	});

	function handler(id: string): (...args: unknown[]) => unknown {
		const h = registered.get(id);
		if (!h) throw new Error(`Command not registered: ${id}`);
		return h;
	}

	function changeItem(fsPath: string) {
		return { uri: vscodeMock.Uri.file(fsPath) };
	}

	test("registers exactly the non-slot gitSort command IDs, in order, one disposable each", () => {
		const disposables = registerGitSortCommands(deps);

		expect([...registered.keys()]).toEqual(EXPECTED_COMMAND_IDS);
		expect(disposables).toHaveLength(EXPECTED_COMMAND_IDS.length);
		for (const disposable of disposables) {
			expect(typeof disposable.dispose).toBe("function");
		}
	});

	test("registered set matches the non-slot commandCentral.gitSort.* commands contributed in package.json", () => {
		registerGitSortCommands(deps);

		const contributed = packageJson.contributes.commands
			.map((c: { command: string }) => c.command)
			.filter(
				(id: string) =>
					id.startsWith("commandCentral.gitSort.") && !id.includes(".slot"),
			);

		expect([...registered.keys()].sort()).toEqual([...contributed].sort());
	});

	test("enable runs the enable-sort command and re-activates the sorter", async () => {
		registerGitSortCommands(deps);

		await handler("commandCentral.gitSort.enable")();

		expect(gitSorter?.enable).toHaveBeenCalledTimes(1);
		// Once inside enable-sort.execute, once again in the handler
		expect(gitSorter?.activate).toHaveBeenCalledTimes(2);
	});

	test("disable runs the disable-sort command", async () => {
		registerGitSortCommands(deps);

		await handler("commandCentral.gitSort.disable")();

		expect(gitSorter?.disable).toHaveBeenCalledTimes(1);
	});

	test("enable/disable are graceful no-ops while the sorter does not exist", async () => {
		const sorter = gitSorter;
		gitSorter = undefined;
		registerGitSortCommands(deps);

		await handler("commandCentral.gitSort.enable")();
		await handler("commandCentral.gitSort.disable")();

		expect(sorter?.enable).not.toHaveBeenCalled();
		expect(sorter?.disable).not.toHaveBeenCalled();
	});

	test("refreshView resolves the provider by view ID and refreshes it", () => {
		registerGitSortCommands(deps);

		handler("commandCentral.gitSort.refreshView")("commandCentral.slot1");

		expect(projectViewManager?.getProviderByViewId).toHaveBeenCalledWith(
			"commandCentral.slot1",
		);
		expect(provider.refresh).toHaveBeenCalledTimes(1);
	});

	test("refreshView logs an error when no provider resolves", () => {
		projectViewManager = undefined;
		registerGitSortCommands(deps);

		handler("commandCentral.gitSort.refreshView")();

		expect(logger.error).toHaveBeenCalledWith(
			"❌ No provider found for refresh",
		);
	});

	test("changeSortOrder toggles newest → oldest and confirms via status bar", async () => {
		registerGitSortCommands(deps);

		await handler("commandCentral.gitSort.changeSortOrder")(
			"commandCentral.slot1",
		);

		expect(provider.setSortOrder).toHaveBeenCalledWith("oldest");
		expect(vscodeMock.window.setStatusBarMessage).toHaveBeenCalledWith(
			"Sorted ▲",
			2000,
		);
	});

	test("changeFileFilter logs and bails while the filter view manager does not exist", async () => {
		registerGitSortCommands(deps);

		await handler("commandCentral.gitSort.changeFileFilter")();

		expect(logger.error).toHaveBeenCalledWith(
			"Extension filter view manager not initialized",
		);
	});

	test("openChange routes through the provider that owns the file", async () => {
		registerGitSortCommands(deps);
		const item = changeItem("/mock/workspace/src/a.ts");

		await handler("commandCentral.gitSort.openChange")(item);

		expect(projectViewManager?.getProviderForFile).toHaveBeenCalledWith(
			item.uri,
		);
		expect(provider.openChange).toHaveBeenCalledWith(item);
	});

	test("openChange without a URI logs and never touches the view manager", async () => {
		registerGitSortCommands(deps);

		await handler("commandCentral.gitSort.openChange")(undefined);

		expect(logger.error).toHaveBeenCalledWith(
			"openChange called with invalid item (no URI)",
		);
		expect(projectViewManager?.getProviderForFile).not.toHaveBeenCalled();
	});

	test("openFile delegates to vscode.open", async () => {
		registerGitSortCommands(deps);
		const item = changeItem("/mock/workspace/src/a.ts");

		await handler("commandCentral.gitSort.openFile")(item);

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			item.uri,
		);
	});

	test("copyPath delegates to the tree-view util (clipboard write)", async () => {
		registerGitSortCommands(deps);

		await handler("commandCentral.gitSort.copyPath")(
			changeItem("/mock/workspace/src/a.ts"),
		);

		expect(vscodeMock.env.clipboard.writeText).toHaveBeenCalledWith(
			"/mock/workspace/src/a.ts",
		);
	});

	test("selectForCompare then compareWithSelected opens the diff", async () => {
		registerGitSortCommands(deps);
		const left = changeItem("/mock/workspace/src/a.ts");
		const right = changeItem("/mock/workspace/src/b.ts");

		await handler("commandCentral.gitSort.selectForCompare")(left);
		await handler("commandCentral.gitSort.compareWithSelected")(right);

		expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.diff",
			left.uri,
			right.uri,
			"a.ts ↔ b.ts",
		);
	});

	test("openInIntegratedTerminal falls back to the integrated terminal while no terminal manager exists", async () => {
		registerGitSortCommands(deps);

		await handler("commandCentral.gitSort.openInIntegratedTerminal")(
			changeItem("/mock/workspace/src/a.ts"),
		);

		expect(vscodeMock.window.createTerminal).toHaveBeenCalledWith({
			name: "Terminal - a.ts",
			cwd: "/mock/workspace/src",
		});
	});

	test("openInIntegratedTerminal resolves the terminal manager lazily — late-binding contract", async () => {
		// Registration happens long before terminalManager is constructed in
		// activate(); the handler must pick up the manager assigned afterwards.
		registerGitSortCommands(deps);
		terminalManager = { runInProjectTerminal: mock(() => Promise.resolve()) };

		await handler("commandCentral.gitSort.openInIntegratedTerminal")(
			changeItem("/mock/workspace/src/a.ts"),
		);

		expect(terminalManager.runInProjectTerminal).toHaveBeenCalledWith(
			"/mock/workspace/src",
			undefined,
			"/mock/workspace/src",
		);
		expect(vscodeMock.window.createTerminal).not.toHaveBeenCalled();
	});

	const uriGuardCases = [
		[
			"commandCentral.gitSort.revealInExplorer",
			() => vscodeMock.commands.executeCommand,
		],
		[
			"commandCentral.gitSort.copyPath",
			() => vscodeMock.env.clipboard.writeText,
		],
		[
			"commandCentral.gitSort.copyRelativePath",
			() => vscodeMock.env.clipboard.writeText,
		],
		[
			"commandCentral.gitSort.openToSide",
			() => vscodeMock.commands.executeCommand,
		],
		[
			"commandCentral.gitSort.revealInFinder",
			() => vscodeMock.commands.executeCommand,
		],
		[
			"commandCentral.gitSort.openInIntegratedTerminal",
			() => vscodeMock.window.createTerminal,
		],
		[
			"commandCentral.gitSort.openWith",
			() => vscodeMock.commands.executeCommand,
		],
		[
			"commandCentral.gitSort.openPreview",
			() => vscodeMock.commands.executeCommand,
		],
	] as const;

	for (const [commandId, effect] of uriGuardCases) {
		test(`${commandId} is a graceful no-op without a URI`, async () => {
			registerGitSortCommands(deps);

			await handler(commandId)(undefined);
			await handler(commandId)({});

			expect(effect()).not.toHaveBeenCalled();
		});
	}
});
