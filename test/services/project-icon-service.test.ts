/**
 * ProjectIconService Tests
 *
 * Validates status bar icon management for workspace projects.
 * These tests protect against:
 * - No project icon in status bar even when configured
 * - Icon not updating when user changes settings
 * - Status bar item not disposed (memory leak)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

let configValues: Record<string, unknown> = {};
let configChangeListeners: Array<
	(e: { affectsConfiguration: (s: string) => boolean }) => void
> = [];
let mockStatusBarItem: {
	text: string;
	tooltip: string;
	command: string;
	show: ReturnType<typeof mock>;
	hide: ReturnType<typeof mock>;
	dispose: ReturnType<typeof mock>;
};
let mockWorkspaceFolders:
	| Array<{
			uri: { fsPath: string };
			name: string;
			index: number;
	  }>
	| undefined;

function createMockStatusBarItem() {
	mockStatusBarItem = {
		text: "",
		tooltip: "",
		command: "",
		show: mock(() => {}),
		hide: mock(() => {}),
		dispose: mock(() => {}),
	};
	return mockStatusBarItem;
}

mock.module("vscode", () => ({
	workspace: {
		get workspaceFolders() {
			return mockWorkspaceFolders;
		},
		getConfiguration: (_section?: string) => ({
			get: <T>(key: string, defaultValue?: T): T | undefined => {
				const fullKey = _section ? `${_section}.${key}` : key;
				const val = configValues[fullKey];
				return (val !== undefined ? val : defaultValue) as T | undefined;
			},
		}),
		onDidChangeConfiguration: (
			listener: (e: { affectsConfiguration: (s: string) => boolean }) => void,
		) => {
			configChangeListeners.push(listener);
			return {
				dispose: () => {
					configChangeListeners = configChangeListeners.filter(
						(l) => l !== listener,
					);
				},
			};
		},
	},
	window: {
		createStatusBarItem: mock((_alignment?: number, _priority?: number) =>
			createMockStatusBarItem(),
		),
		showInformationMessage: mock(() => Promise.resolve()),
	},
	StatusBarAlignment: {
		Left: 1,
		Right: 2,
	},
	commands: {
		executeCommand: mock(() => Promise.resolve()),
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

import { ProjectIconService } from "../../src/services/project-icon-service.js";

// Mock logger
const mockLogger = {
	info: mock(() => {}),
	debug: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	show: mock(() => {}),
	dispose: mock(() => {}),
} as unknown as import("../../src/services/logger-service.js").LoggerService;

// Mock extension context
const mockContext = {
	subscriptions: [] as Array<{ dispose: () => void }>,
} as unknown as import("vscode").ExtensionContext;

describe("ProjectIconService", () => {
	beforeEach(() => {
		configValues = {};
		configChangeListeners = [];
		mockWorkspaceFolders = [
			{
				uri: { fsPath: "/home/user/my-project" },
				name: "my-project",
				index: 0,
			},
		];
		mockContext.subscriptions = [];
	});

	test("creates status bar item when icon configured", () => {
		configValues["commandCentral.project.icon"] = "🎯";

		const service = new ProjectIconService(mockLogger, mockContext);

		expect(mockStatusBarItem).toBeDefined();
		expect(mockStatusBarItem.show).toHaveBeenCalled();

		service.dispose();
	});

	test("shows configured emoji as status bar text", () => {
		configValues["commandCentral.project.icon"] = "🔥";

		const service = new ProjectIconService(mockLogger, mockContext);

		expect(mockStatusBarItem.text).toBe("🔥");

		service.dispose();
	});

	test("uses custom project name as tooltip when configured", () => {
		configValues["commandCentral.project.icon"] = "⭐";
		configValues["commandCentral.project.name"] = "My Cool Project";

		const service = new ProjectIconService(mockLogger, mockContext);

		expect(mockStatusBarItem.tooltip).toBe("My Cool Project");

		service.dispose();
	});

	test("uses default tooltip when no custom name configured", () => {
		configValues["commandCentral.project.icon"] = "⭐";

		const service = new ProjectIconService(mockLogger, mockContext);

		// When no project.name is set, tooltip falls back to "Project Icon"
		expect(mockStatusBarItem.tooltip).toBe("Project Icon");

		service.dispose();
	});

	test("does not create status bar item when no icon configured", () => {
		// No icon or name configured
		configValues = {};

		// Get reference to the createStatusBarItem mock and reset it
		const vscode = require("vscode");
		const createSpy = vscode.window.createStatusBarItem as ReturnType<
			typeof mock
		>;
		createSpy.mockClear();

		const service = new ProjectIconService(mockLogger, mockContext);

		// When no icon or name is configured, the service should NOT create
		// a status bar item at all
		expect(createSpy).not.toHaveBeenCalled();

		service.dispose();
	});

	test("refreshes when commandCentral.project config changes", () => {
		configValues["commandCentral.project.icon"] = "🎯";
		const service = new ProjectIconService(mockLogger, mockContext);

		// Now change config
		configValues["commandCentral.project.icon"] = "🚀";

		// Simulate config change event
		for (const listener of configChangeListeners) {
			listener({
				affectsConfiguration: (section: string) =>
					section === "commandCentral.project" ||
					section === "commandCentral.statusBar",
			});
		}

		expect(mockStatusBarItem.text).toBe("🚀");

		service.dispose();
	});

	test("does not refresh for unrelated config changes", () => {
		configValues["commandCentral.project.icon"] = "🎯";
		const service = new ProjectIconService(mockLogger, mockContext);

		const showCallCount = mockStatusBarItem.show.mock.calls.length;

		// Simulate unrelated config change
		for (const listener of configChangeListeners) {
			listener({
				affectsConfiguration: (section: string) =>
					section === "editor.fontSize",
			});
		}

		// show should not have been called again
		expect(mockStatusBarItem.show.mock.calls.length).toBe(showCallCount);

		service.dispose();
	});

	test("dispose cleans up status bar item and listeners", () => {
		configValues["commandCentral.project.icon"] = "🎯";
		const service = new ProjectIconService(mockLogger, mockContext);

		const listenerCountBefore = configChangeListeners.length;
		expect(listenerCountBefore).toBeGreaterThan(0);

		service.dispose();

		expect(mockStatusBarItem.dispose).toHaveBeenCalled();
		// Listener should have been removed
		expect(configChangeListeners.length).toBe(0);
	});
});
