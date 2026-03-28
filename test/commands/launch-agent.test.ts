/**
 * Launch Agent Command Tests
 *
 * Tests the commandCentral.launchAgent command that spawns a new Ghostty
 * terminal via oste-spawn.sh from the sidebar.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { buildOsteSpawnCommand } from "../../src/utils/shell-command.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Capture real writeFileSync before mock.module overwrites it
const originalWriteFileSync = realFs.writeFileSync.bind(realFs);
// Mock fs — track writeFileSync calls while still performing the real write
const mockWriteFileSync = mock(
	(...args: Parameters<typeof realFs.writeFileSync>) => {
		return originalWriteFileSync(...args);
	},
);
mock.module("node:fs", () => ({
	...realFs,
	writeFileSync: mockWriteFileSync,
	existsSync: () => true,
}));

describe("launchAgent command", () => {
	let vscodeMock: ReturnType<typeof setupVSCodeMock>;
	let commandHandler: () => Promise<void>;
	const mockRunInProjectTerminal = mock(
		(_projectDir: string, _command: string) => Promise.resolve(),
	);

	beforeEach(() => {
		mock.restore();
		vscodeMock = setupVSCodeMock();
		mockWriteFileSync.mockClear();
		mockRunInProjectTerminal.mockClear();

		// Add missing mock methods
		vscodeMock.window.showInputBox = mock(() => Promise.resolve("Test task"));
		vscodeMock.workspace.showWorkspaceFolderPick = mock(() =>
			Promise.resolve({
				uri: { fsPath: "/mock/workspace" },
				name: "workspace",
				index: 0,
			}),
		);

		// Capture registered command handler
		vscodeMock.commands.registerCommand = mock(
			(_id: string, _handler: (...args: unknown[]) => unknown) => {
				if (_id === "commandCentral.launchAgent") {
					commandHandler = _handler as () => Promise<void>;
				}
				return { dispose: mock() };
			},
		);
	});

	function registerCommand() {
		// Simulate what extension.ts does
		const vscode = vscodeMock;
		const agentStatusProvider = { reload: mock() };
		const terminalManager = { runInProjectTerminal: mockRunInProjectTerminal };

		vscode.commands.registerCommand("commandCentral.launchAgent", async () => {
			let projectDir: string;
			const folders = vscode.workspace.workspaceFolders;
			if (!folders || folders.length === 0) {
				vscode.window.showWarningMessage("No workspace folder open.");
				return;
			}
			if (folders.length === 1) {
				const first = folders[0];
				if (!first) return;
				projectDir = first.uri.fsPath;
			} else {
				const picked = (await vscode.workspace.showWorkspaceFolderPick({
					placeHolder: "Select project for agent",
				})) as { uri: { fsPath: string } } | undefined;
				if (!picked) return;
				projectDir = picked.uri.fsPath;
			}

			const description = (await vscode.window.showInputBox({
				prompt: "What should the agent do?",
				placeHolder: "e.g., Add unit tests for the auth module",
			})) as string | undefined;
			if (!description) return;

			const fs = await import("node:fs");
			const timestamp = Date.now().toString(36);
			const promptFile = `/tmp/cc-launch-${timestamp}.md`;
			fs.writeFileSync(promptFile, `# Task\n\n${description}\n`);

			const path = await import("node:path");
			const dirName = path.basename(projectDir);
			const taskId = `cc-${dirName}-${timestamp}`;

			const configuredBackend = vscode.workspace
				.getConfiguration("commandCentral.agentStatus")
				.get("defaultBackend", "codex");
			const backend = configuredBackend === "gemini" ? "gemini" : "codex";

			try {
				const command = buildOsteSpawnCommand({
					projectDir,
					promptFile,
					taskId,
					backend,
					role: "developer",
				});
				await terminalManager.runInProjectTerminal(projectDir, command);

				vscode.window.showInformationMessage(`Agent launched for ${dirName}`);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to launch agent: ${msg}`);
			}

			setTimeout(() => {
				agentStatusProvider?.reload();
			}, 2000);
		});

		return { agentStatusProvider, terminalManager };
	}

	test("single workspace folder: uses it directly without QuickPick", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/my-app" }, name: "my-app", index: 0 },
		];
		registerCommand();
		await commandHandler();

		// Should NOT call showWorkspaceFolderPick
		expect(vscodeMock.workspace.showWorkspaceFolderPick).not.toHaveBeenCalled();
		// Should proceed to showInputBox
		expect(vscodeMock.window.showInputBox).toHaveBeenCalled();
	});

	test("multiple workspace folders: shows QuickPick", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/app-a" }, name: "app-a", index: 0 },
			{ uri: { fsPath: "/projects/app-b" }, name: "app-b", index: 1 },
		];
		vscodeMock.workspace.showWorkspaceFolderPick = mock(() =>
			Promise.resolve({
				uri: { fsPath: "/projects/app-a" },
				name: "app-a",
				index: 0,
			}),
		);
		registerCommand();
		await commandHandler();

		expect(vscodeMock.workspace.showWorkspaceFolderPick).toHaveBeenCalled();
	});

	test("QuickPick cancelled: returns without spawning", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/app-a" }, name: "app-a", index: 0 },
			{ uri: { fsPath: "/projects/app-b" }, name: "app-b", index: 1 },
		];
		vscodeMock.workspace.showWorkspaceFolderPick = mock(() =>
			Promise.resolve(undefined),
		);
		registerCommand();
		await commandHandler();

		expect(vscodeMock.window.showInputBox).not.toHaveBeenCalled();
		expect(mockRunInProjectTerminal).not.toHaveBeenCalled();
	});

	test("InputBox cancelled: returns without spawning", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/my-app" }, name: "my-app", index: 0 },
		];
		vscodeMock.window.showInputBox = mock(() => Promise.resolve(undefined));
		registerCommand();
		await commandHandler();

		expect(mockRunInProjectTerminal).not.toHaveBeenCalled();
	});

	test("prompt file is written to /tmp with correct content", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/my-app" }, name: "my-app", index: 0 },
		];
		vscodeMock.window.showInputBox = mock(() =>
			Promise.resolve("Fix the login bug"),
		);
		registerCommand();
		await commandHandler();

		expect(mockWriteFileSync).toHaveBeenCalled();
		const [filePath, content] = mockWriteFileSync.mock.calls[0] as unknown as [
			string,
			string,
		];
		expect(filePath).toStartWith("/tmp/cc-launch-");
		expect(filePath).toEndWith(".md");
		expect(content).toBe("# Task\n\nFix the login bug\n");
	});

	test("prompt file content starts with # Task header", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/my-app" }, name: "my-app", index: 0 },
		];
		vscodeMock.window.showInputBox = mock(() => Promise.resolve("Add tests"));
		registerCommand();
		await commandHandler();

		const [, content] = mockWriteFileSync.mock.calls[0] as unknown as [
			string,
			string,
		];
		expect(content).toStartWith("# Task\n\n");
	});

	test("task ID format: cc-{dirname}-{base36timestamp}", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/my-app" }, name: "my-app", index: 0 },
		];
		registerCommand();
		await commandHandler();

		const [, command] = mockRunInProjectTerminal.mock.calls[0] as [
			string,
			string,
		];
		const taskIdMatch = command.match(/'--task-id' '([^']+)'/);
		expect(taskIdMatch).toBeDefined();
		const taskId = taskIdMatch?.[1] ?? "";
		expect(taskId).toStartWith("cc-my-app-");
		// The rest should be a valid base36 string
		const base36Part = taskId.replace("cc-my-app-", "");
		expect(base36Part).toMatch(/^[0-9a-z]+$/);
	});

	test("successful spawn shows information message with project name", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{
				uri: { fsPath: "/projects/cool-project" },
				name: "cool-project",
				index: 0,
			},
		];
		registerCommand();
		await commandHandler();

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Agent launched for cool-project",
		);
	});

	test("failed spawn shows error message with error details", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/my-app" }, name: "my-app", index: 0 },
		];
		mockRunInProjectTerminal.mockImplementation(() =>
			Promise.reject(new Error("spawn oste-spawn.sh ENOENT")),
		);
		registerCommand();
		await commandHandler();

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to launch agent: spawn oste-spawn.sh ENOENT",
		);
	});

	test("no workspace folders: shows warning message", async () => {
		vscodeMock.workspace.workspaceFolders = [] as Array<{
			uri: { fsPath: string };
			name: string;
			index: number;
		}>;
		registerCommand();
		await commandHandler();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No workspace folder open.",
		);
		expect(mockRunInProjectTerminal).not.toHaveBeenCalled();
	});

	test("routes launch through project terminal with bundle-aware command", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/my-app" }, name: "my-app", index: 0 },
		];
		registerCommand();
		await commandHandler();

		expect(mockRunInProjectTerminal).toHaveBeenCalled();
		const [projectDir, command] = mockRunInProjectTerminal.mock.calls[0] as [
			string,
			string,
		];
		expect(projectDir).toBe("/projects/my-app");
		expect(command).toContain("'oste-spawn.sh' '/projects/my-app'");
		expect(command).toContain("'--task-id' 'cc-my-app-");
		expect(command).toContain("'--role' 'developer'");
		expect(command).toContain("'--agent' 'codex'");
		expect(command).not.toContain("--no-bundle");
	});

	test("uses configured gemini backend when set", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/my-app" }, name: "my-app", index: 0 },
		];
		vscodeMock.workspace.getConfiguration = mock((section?: string) => ({
			get: mock((key: string, defaultValue?: unknown) => {
				if (
					section === "commandCentral.agentStatus" &&
					key === "defaultBackend"
				) {
					return "gemini";
				}
				return defaultValue;
			}),
			update: mock(() => Promise.resolve()),
		}));

		registerCommand();
		await commandHandler();

		const [, command] = mockRunInProjectTerminal.mock.calls[0] as [
			string,
			string,
		];
		expect(command).toContain("'--agent' 'gemini'");
	});

	test("escapes workspace-derived values containing spaces and double quotes", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{
				uri: { fsPath: '/projects/My "Odd" App' },
				name: 'My "Odd" App',
				index: 0,
			},
		];
		registerCommand();
		await commandHandler();

		const [projectDir, command] = mockRunInProjectTerminal.mock.calls[0] as [
			string,
			string,
		];
		expect(projectDir).toBe('/projects/My "Odd" App');
		expect(command).toContain(`'/projects/My "Odd" App'`);
		expect(command).toContain(`'--task-id' 'cc-My "Odd" App-`);
	});

	test("reload() is scheduled after spawn via setTimeout", async () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: "/projects/my-app" }, name: "my-app", index: 0 },
		];
		const originalSetTimeout = globalThis.setTimeout;
		const setTimeoutCalls: Array<{ fn: () => void; delay: number }> = [];
		globalThis.setTimeout = ((fn: () => void, delay: number) => {
			setTimeoutCalls.push({ fn, delay });
			return originalSetTimeout(fn, delay);
		}) as typeof globalThis.setTimeout;

		const { agentStatusProvider } = registerCommand();
		await commandHandler();

		globalThis.setTimeout = originalSetTimeout;

		// Verify setTimeout was called with 2000ms delay
		const reloadCall = setTimeoutCalls.find((c) => c.delay === 2000);
		expect(reloadCall).toBeDefined();

		// Execute the callback to verify it calls reload
		reloadCall?.fn();
		expect(agentStatusProvider.reload).toHaveBeenCalled();
	});

	test("null workspace folders: shows warning message", async () => {
		vscodeMock.workspace.workspaceFolders = undefined as unknown as Array<{
			uri: { fsPath: string };
			name: string;
			index: number;
		}>;
		registerCommand();
		await commandHandler();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No workspace folder open.",
		);
	});
});
