/**
 * WorkspaceProjectSource Tests
 *
 * Validates mapping of workspace folders to dynamic view slots.
 * These tests protect against:
 * - Multi-folder workspaces showing NO projects in sidebar
 * - Incorrect slot assignment
 * - >10 folders crashing or showing no warning
 * - Custom project icons not displaying
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

let mockWorkspaceFolders:
	| Array<{
			uri: { fsPath: string };
			name: string;
			index: number;
	  }>
	| undefined;

let executeCommandCalls: Array<{ command: string; args: unknown[] }> = [];
let configByScope: Map<string, Record<string, unknown>> = new Map();
let showInfoCalls: string[] = [];

mock.module("vscode", () => ({
	workspace: {
		get workspaceFolders() {
			return mockWorkspaceFolders;
		},
		getConfiguration: (section?: string, scope?: { fsPath: string }) => {
			const key = scope ? scope.fsPath : "__global__";
			const scopeConfig = configByScope.get(key) || {};
			return {
				get: <T>(configKey: string, defaultValue?: T): T | undefined => {
					const fullKey = section ? `${section}.${configKey}` : configKey;
					const val = scopeConfig[fullKey];
					return (val !== undefined ? val : defaultValue) as T | undefined;
				},
			};
		},
		onDidChangeConfiguration: () => ({ dispose: () => {} }),
	},
	commands: {
		executeCommand: mock((...args: unknown[]) => {
			executeCommandCalls.push({
				command: args[0] as string,
				args: args.slice(1),
			});
			return Promise.resolve();
		}),
	},
	window: {
		showInformationMessage: mock((...args: unknown[]) => {
			showInfoCalls.push(args[0] as string);
			return Promise.resolve();
		}),
	},
	EventEmitter: class<T = void> {
		private listeners: Array<(e: T) => void> = [];
		event = (listener: (e: T) => void) => {
			this.listeners.push(listener);
			return { dispose: () => {} };
		};
		fire(data: T): void {
			for (const listener of this.listeners) listener(data);
		}
		dispose(): void {
			this.listeners = [];
		}
	},
}));

import { WorkspaceProjectSource } from "../../src/config/workspace-project-source.js";

// Minimal logger mock
const mockLogger = {
	info: mock(() => {}),
	debug: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	show: mock(() => {}),
	dispose: mock(() => {}),
} as unknown as import("../../src/services/logger-service.js").LoggerService;

describe("WorkspaceProjectSource", () => {
	let source: WorkspaceProjectSource;

	beforeEach(() => {
		mockWorkspaceFolders = undefined;
		executeCommandCalls = [];
		configByScope = new Map();
		showInfoCalls = [];
		source = new WorkspaceProjectSource(mockLogger);
	});

	test("returns empty array when no workspace folders exist", async () => {
		mockWorkspaceFolders = undefined;
		const projects = await source.loadProjects();
		expect(projects).toEqual([]);
	});

	test("returns empty array when workspace folders is empty", async () => {
		mockWorkspaceFolders = [];
		const projects = await source.loadProjects();
		expect(projects).toEqual([]);
	});

	test("maps single workspace folder to slot1", async () => {
		mockWorkspaceFolders = [
			{
				uri: { fsPath: "/home/user/my-project" },
				name: "my-project",
				index: 0,
			},
		];

		const projects = await source.loadProjects();

		expect(projects).toHaveLength(1);
		expect(projects[0]?.id).toBe("slot1");
		expect(projects[0]?.sortOrder).toBe(1);
		expect(projects[0]?.gitPath).toBe("/home/user/my-project");
	});

	test("maps multiple workspace folders to sequential slots", async () => {
		mockWorkspaceFolders = [
			{ uri: { fsPath: "/home/user/project-a" }, name: "project-a", index: 0 },
			{ uri: { fsPath: "/home/user/project-b" }, name: "project-b", index: 1 },
			{ uri: { fsPath: "/home/user/project-c" }, name: "project-c", index: 2 },
		];

		const projects = await source.loadProjects();

		expect(projects).toHaveLength(3);
		expect(projects[0]?.id).toBe("slot1");
		expect(projects[1]?.id).toBe("slot2");
		expect(projects[2]?.id).toBe("slot3");
		expect(projects[0]?.sortOrder).toBe(1);
		expect(projects[1]?.sortOrder).toBe(2);
		expect(projects[2]?.sortOrder).toBe(3);
	});

	test("extracts folder name from filesystem path correctly", async () => {
		mockWorkspaceFolders = [
			{
				uri: { fsPath: "/deeply/nested/path/to/my-awesome-project" },
				name: "my-awesome-project",
				index: 0,
			},
		];

		const projects = await source.loadProjects();

		expect(projects[0]?.displayName).toBe("my-awesome-project");
	});

	test("limits to 10 slots when >10 workspace folders present", async () => {
		mockWorkspaceFolders = Array.from({ length: 15 }, (_, i) => ({
			uri: { fsPath: `/home/user/project-${i}` },
			name: `project-${i}`,
			index: i,
		}));

		const projects = await source.loadProjects();

		expect(projects).toHaveLength(10);
		expect(projects[9]?.id).toBe("slot10");
	});

	test("shows truncation warning once for >10 folders", async () => {
		mockWorkspaceFolders = Array.from({ length: 12 }, (_, i) => ({
			uri: { fsPath: `/home/user/project-${i}` },
			name: `project-${i}`,
			index: i,
		}));

		await source.loadProjects();
		expect(showInfoCalls).toHaveLength(1);
		expect(showInfoCalls[0]).toContain("10");
		expect(showInfoCalls[0]).toContain("12");

		// Second call should NOT show warning again
		showInfoCalls = [];
		await source.loadProjects();
		expect(showInfoCalls).toHaveLength(0);
	});

	test("does not show truncation warning for ≤10 folders", async () => {
		mockWorkspaceFolders = Array.from({ length: 10 }, (_, i) => ({
			uri: { fsPath: `/home/user/project-${i}` },
			name: `project-${i}`,
			index: i,
		}));

		await source.loadProjects();
		expect(showInfoCalls).toHaveLength(0);
	});

	test("clears all 10 slots before mapping new ones", async () => {
		mockWorkspaceFolders = [
			{ uri: { fsPath: "/home/user/project" }, name: "project", index: 0 },
		];

		await source.loadProjects();

		// Should have 10 setContext calls setting slots to false (clearing)
		const clearCalls = executeCommandCalls.filter(
			(c) =>
				c.command === "setContext" &&
				(c.args[1] as boolean) === false &&
				(c.args[0] as string).startsWith("commandCentral.slot"),
		);
		expect(clearCalls).toHaveLength(10);
	});

	test("sets context keys for active slots", async () => {
		mockWorkspaceFolders = [
			{ uri: { fsPath: "/home/user/project-a" }, name: "project-a", index: 0 },
			{ uri: { fsPath: "/home/user/project-b" }, name: "project-b", index: 1 },
		];

		await source.loadProjects();

		// Should have setContext calls setting active slots to true
		const enableCalls = executeCommandCalls.filter(
			(c) => c.command === "setContext" && (c.args[1] as boolean) === true,
		);
		expect(enableCalls).toHaveLength(2);
		expect(enableCalls[0]?.args[0]).toBe("commandCentral.slot1.active");
		expect(enableCalls[1]?.args[0]).toBe("commandCentral.slot2.active");
	});

	test("reads custom project.icon from workspace-folder settings", async () => {
		mockWorkspaceFolders = [
			{ uri: { fsPath: "/home/user/ghosty" }, name: "ghosty", index: 0 },
		];

		// Set custom icon for this workspace folder
		configByScope.set("/home/user/ghosty", {
			"commandCentral.project.icon": "👻",
		});

		const projects = await source.loadProjects();

		expect(projects[0]?.displayName).toBe("👻 ghosty");
	});

	test("prepends custom icon emoji to folder display name", async () => {
		mockWorkspaceFolders = [
			{
				uri: { fsPath: "/home/user/rocket-app" },
				name: "rocket-app",
				index: 0,
			},
		];

		configByScope.set("/home/user/rocket-app", {
			"commandCentral.project.icon": "🚀",
		});

		const projects = await source.loadProjects();

		expect(projects[0]?.displayName).toStartWith("🚀");
		expect(projects[0]?.displayName).toContain("rocket-app");
	});

	test("works without custom icon (just folder name)", async () => {
		mockWorkspaceFolders = [
			{
				uri: { fsPath: "/home/user/plain-project" },
				name: "plain-project",
				index: 0,
			},
		];

		// No custom config set
		const projects = await source.loadProjects();

		expect(projects[0]?.displayName).toBe("plain-project");
	});
});
