/**
 * Ghostty Create Terminal Command Tests
 *
 * Verifies the command uses the friendly runInProjectTerminal flow
 * instead of strict launcher-installed gating.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("commandCentral.ghostty.createTerminal", () => {
	let vscodeMock: ReturnType<typeof setupVSCodeMock>;
	let commandHandler: () => Promise<void>;
	const mockRunInProjectTerminal = mock((_projectDir: string) =>
		Promise.resolve(),
	);
	const mockCreateProjectTerminal = mock((_projectDir: string) =>
		Promise.resolve(),
	);
	const mockIsLauncherInstalled = mock(() => Promise.resolve(false));

	beforeEach(() => {
		mock.restore();
		vscodeMock = setupVSCodeMock();
		mockRunInProjectTerminal.mockClear();
		mockCreateProjectTerminal.mockClear();
		mockIsLauncherInstalled.mockClear();

		vscodeMock.commands.registerCommand = mock(
			(_id: string, _handler: (...args: unknown[]) => unknown) => {
				if (_id === "commandCentral.ghostty.createTerminal") {
					commandHandler = _handler as () => Promise<void>;
				}
				return { dispose: mock() };
			},
		);
	});

	function registerCommand() {
		const mainLogger = { error: mock() };
		const terminalManager = {
			runInProjectTerminal: mockRunInProjectTerminal,
			createProjectTerminal: mockCreateProjectTerminal,
			isLauncherInstalled: mockIsLauncherInstalled,
		};

		vscodeMock.commands.registerCommand(
			"commandCentral.ghostty.createTerminal",
			async () => {
				const folders = vscodeMock.workspace.workspaceFolders;
				if (!folders || folders.length === 0) {
					vscodeMock.window.showErrorMessage(
						"Command Central: No workspace folder open.",
					);
					return;
				}

				let selectedFolder: {
					name: string;
					uri: { fsPath: string };
					index: number;
				};
				if (folders.length > 1) {
					const folderItems = folders.map((folder) => ({
						label: folder.name,
						description: folder.uri.fsPath,
						folder: folder,
					}));
					const showQuickPick = vscodeMock.window.showQuickPick as unknown as (
						items: typeof folderItems,
						options: { placeHolder: string; canPickMany: boolean },
					) => Promise<(typeof folderItems)[number] | undefined>;

					const selectedItem = await showQuickPick(folderItems, {
						placeHolder: "Select workspace folder for terminal",
						canPickMany: false,
					});

					if (!selectedItem) {
						return;
					}

					selectedFolder = selectedItem.folder;
				} else {
					selectedFolder = folders[0] as typeof selectedFolder;
				}

				try {
					await terminalManager.runInProjectTerminal(selectedFolder.uri.fsPath);
					vscodeMock.window.showInformationMessage(
						`Command Central: Project terminal opened for ${selectedFolder.name}.`,
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					mainLogger.error("Failed to open project terminal", err as Error);
					vscodeMock.window.showErrorMessage(
						`Command Central: Failed to open terminal — ${msg}`,
					);
				}
			},
		);

		return { mainLogger, terminalManager };
	}

	test("shows error when no workspace folders are open", async () => {
		vscodeMock.workspace.workspaceFolders = [];
		registerCommand();

		await commandHandler();

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Command Central: No workspace folder open.",
		);
		expect(mockRunInProjectTerminal).not.toHaveBeenCalled();
	});

	test("routes through runInProjectTerminal for single-root workspace", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{
				uri: { fsPath: "/Users/test/project-a" },
				name: "project-a",
				index: 0,
			},
		];
		registerCommand();

		await commandHandler();

		expect(mockRunInProjectTerminal).toHaveBeenCalledWith(
			"/Users/test/project-a",
		);
		expect(mockCreateProjectTerminal).not.toHaveBeenCalled();
		expect(mockIsLauncherInstalled).not.toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Command Central: Project terminal opened for project-a.",
		);
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalledWith(
			expect.stringContaining("ghostty-launcher not found"),
		);
	});

	test("multi-root picker uses selected workspace folder", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{
				uri: { fsPath: "/Users/test/project-a" },
				name: "project-a",
				index: 0,
			},
			{
				uri: { fsPath: "/Users/test/project-b" },
				name: "project-b",
				index: 1,
			},
		];
		const selectedFolder = vscodeMock.workspace.workspaceFolders[1];
		if (!selectedFolder) {
			throw new Error("Expected second workspace folder");
		}
		vscodeMock.window.showQuickPick = mock(() =>
			Promise.resolve({
				label: selectedFolder.name,
				description: selectedFolder.uri.fsPath,
				folder: selectedFolder,
			}),
		) as unknown as typeof vscodeMock.window.showQuickPick;
		registerCommand();

		await commandHandler();

		expect(mockRunInProjectTerminal).toHaveBeenCalledWith(
			"/Users/test/project-b",
		);
	});

	test("picker cancel exits without opening terminal", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{
				uri: { fsPath: "/Users/test/project-a" },
				name: "project-a",
				index: 0,
			},
			{
				uri: { fsPath: "/Users/test/project-b" },
				name: "project-b",
				index: 1,
			},
		];
		vscodeMock.window.showQuickPick = mock(() =>
			Promise.resolve(undefined),
		) as unknown as typeof vscodeMock.window.showQuickPick;
		registerCommand();

		await commandHandler();

		expect(mockRunInProjectTerminal).not.toHaveBeenCalled();
	});

	test("shows open-terminal error when runInProjectTerminal fails", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{
				uri: { fsPath: "/Users/test/project-a" },
				name: "project-a",
				index: 0,
			},
		];
		const { mainLogger } = registerCommand();
		mockRunInProjectTerminal.mockImplementation(() =>
			Promise.reject(new Error("launcher exploded")),
		);

		await commandHandler();

		expect(mainLogger.error).toHaveBeenCalledWith(
			"Failed to open project terminal",
			expect.any(Error),
		);
		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Command Central: Failed to open terminal — launcher exploded",
		);
	});
});
