import { beforeEach, describe, expect, mock, test } from "bun:test";

let configuredBackend: string = "codex";
let configChangeListeners: Array<
	(e: { affectsConfiguration: (section: string) => boolean }) => void
> = [];
let mockStatusBarItem: {
	text: string;
	tooltip: string;
	command: string;
	show: ReturnType<typeof mock>;
	hide: ReturnType<typeof mock>;
	dispose: ReturnType<typeof mock>;
};

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
		getConfiguration: (section?: string) => ({
			get: <T>(key: string, defaultValue?: T): T | undefined => {
				if (
					section === "commandCentral.agentStatus" &&
					key === "defaultBackend"
				) {
					return configuredBackend as T;
				}
				return defaultValue;
			},
		}),
		onDidChangeConfiguration: (
			listener: (e: {
				affectsConfiguration: (section: string) => boolean;
			}) => void,
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
	},
	StatusBarAlignment: {
		Left: 1,
		Right: 2,
	},
}));

import { AgentBackendSwitcher } from "../../src/services/agent-backend-switcher.js";

describe("AgentBackendSwitcher", () => {
	beforeEach(() => {
		configuredBackend = "codex";
		configChangeListeners = [];

		const vscode = require("vscode") as {
			window: { createStatusBarItem: ReturnType<typeof mock> };
		};
		vscode.window.createStatusBarItem.mockClear();
	});

	test("shows Codex by default and binds switch command", () => {
		const switcher = new AgentBackendSwitcher();

		expect(mockStatusBarItem.text).toBe("$(hubot) Codex");
		expect(mockStatusBarItem.command).toBe("commandCentral.switchAgentBackend");
		expect(mockStatusBarItem.show).toHaveBeenCalled();

		switcher.dispose();
	});

	test("uses right alignment with priority 100", () => {
		const vscode = require("vscode") as {
			window: { createStatusBarItem: ReturnType<typeof mock> };
			StatusBarAlignment: { Right: number };
		};

		const switcher = new AgentBackendSwitcher();

		expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
			vscode.StatusBarAlignment.Right,
			100,
		);

		switcher.dispose();
	});

	test("shows Gemini when configuration is gemini", () => {
		configuredBackend = "gemini";
		const switcher = new AgentBackendSwitcher();

		expect(mockStatusBarItem.text).toBe("$(hubot) Gemini");

		switcher.dispose();
	});

	test("updates status bar text on relevant config change", () => {
		const switcher = new AgentBackendSwitcher();
		expect(mockStatusBarItem.text).toBe("$(hubot) Codex");

		configuredBackend = "gemini";
		for (const listener of configChangeListeners) {
			listener({
				affectsConfiguration: (section: string) =>
					section === "commandCentral.agentStatus.defaultBackend",
			});
		}

		expect(mockStatusBarItem.text).toBe("$(hubot) Gemini");

		switcher.dispose();
	});

	test("ignores unrelated config changes", () => {
		const switcher = new AgentBackendSwitcher();
		const showCount = mockStatusBarItem.show.mock.calls.length;

		configuredBackend = "gemini";
		for (const listener of configChangeListeners) {
			listener({
				affectsConfiguration: (section: string) =>
					section === "editor.fontSize",
			});
		}

		expect(mockStatusBarItem.text).toBe("$(hubot) Codex");
		expect(mockStatusBarItem.show.mock.calls.length).toBe(showCount);

		switcher.dispose();
	});

	test("dispose cleans up listener and status bar item", () => {
		const switcher = new AgentBackendSwitcher();
		expect(configChangeListeners.length).toBeGreaterThan(0);

		switcher.dispose();

		expect(mockStatusBarItem.dispose).toHaveBeenCalled();
		expect(configChangeListeners.length).toBe(0);
	});
});
