/**
 * Tests for TestCountStatusBar
 * Validates status bar item registration and count display
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

describe("TestCountStatusBar", () => {
	let mockStatusBarItem: {
		text: string;
		tooltip: string;
		command: string;
		show: ReturnType<typeof mock>;
		hide: ReturnType<typeof mock>;
		dispose: ReturnType<typeof mock>;
	};

	beforeEach(() => {
		mock.restore();
		const vscodeMock = setupVSCodeMock();
		mockStatusBarItem = {
			text: "",
			tooltip: "",
			command: "",
			show: mock(),
			hide: mock(),
			dispose: mock(),
		};
		vscodeMock.window.createStatusBarItem = mock(() => mockStatusBarItem);
	});

	test("creates status bar item on Left side with priority 100", async () => {
		const vscodeMock = (await import("vscode")) as unknown as {
			window: { createStatusBarItem: ReturnType<typeof mock> };
			StatusBarAlignment: { Left: number };
		};

		const { TestCountStatusBar } = await import(
			"../../src/services/test-count-status-bar.js"
		);
		new TestCountStatusBar();

		expect(vscodeMock.window.createStatusBarItem).toHaveBeenCalledWith(
			vscodeMock.StatusBarAlignment.Left,
			100,
		);
	});

	test("shows status bar item on construction", async () => {
		const { TestCountStatusBar } = await import(
			"../../src/services/test-count-status-bar.js"
		);
		new TestCountStatusBar();

		expect(mockStatusBarItem.show).toHaveBeenCalled();
	});

	test("sets command to command-central.showTestCount", async () => {
		const { TestCountStatusBar } = await import(
			"../../src/services/test-count-status-bar.js"
		);
		new TestCountStatusBar();

		expect(mockStatusBarItem.command).toBe("command-central.showTestCount");
	});

	test("updateCount sets text with count and checkmark", async () => {
		const { TestCountStatusBar } = await import(
			"../../src/services/test-count-status-bar.js"
		);
		const bar = new TestCountStatusBar();

		bar.updateCount(383);

		expect(mockStatusBarItem.text).toBe("CC: 383 tests \u2713");
	});

	test("updateCount works with zero", async () => {
		const { TestCountStatusBar } = await import(
			"../../src/services/test-count-status-bar.js"
		);
		const bar = new TestCountStatusBar();

		bar.updateCount(0);

		expect(mockStatusBarItem.text).toBe("CC: 0 tests \u2713");
	});

	test("dispose disposes the status bar item", async () => {
		const { TestCountStatusBar } = await import(
			"../../src/services/test-count-status-bar.js"
		);
		const bar = new TestCountStatusBar();

		bar.dispose();

		expect(mockStatusBarItem.dispose).toHaveBeenCalled();
	});

	test("initial text shows loading state", async () => {
		const { TestCountStatusBar } = await import(
			"../../src/services/test-count-status-bar.js"
		);
		new TestCountStatusBar();

		expect(mockStatusBarItem.text).toBe("CC: ... tests");
	});
});
