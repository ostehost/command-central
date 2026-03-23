/**
 * Tests for TestCountStatusBar
 * Validates status bar item registration, count display, and refreshCount logic
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
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
	let vscodeMock: ReturnType<typeof setupVSCodeMock>;

	beforeEach(() => {
		mock.restore();
		vscodeMock = setupVSCodeMock();
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
		const vscode = (await import("vscode")) as unknown as {
			window: { createStatusBarItem: ReturnType<typeof mock> };
			StatusBarAlignment: { Left: number };
		};

		const { TestCountStatusBar } = await import(
			"../../src/services/test-count-status-bar.js"
		);
		new TestCountStatusBar();

		expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
			vscode.StatusBarAlignment.Left,
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

	// =========================================================================
	// refreshCount() tests
	// =========================================================================

	describe("refreshCount", () => {
		test("returns 0 and warns in untrusted workspace", async () => {
			vscodeMock.workspace.isTrusted = false;

			const { TestCountStatusBar } = await import(
				"../../src/services/test-count-status-bar.js"
			);
			const bar = new TestCountStatusBar();
			const count = await bar.refreshCount();

			expect(count).toBe(0);
			expect(mockStatusBarItem.text).toBe("CC: tests (untrusted)");
			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
		});

		test("returns 0 and shows 'no workspace' when workspaceFolders is empty", async () => {
			vscodeMock.workspace.isTrusted = true;
			vscodeMock.workspace.workspaceFolders =
				[] as typeof vscodeMock.workspace.workspaceFolders;

			const { TestCountStatusBar } = await import(
				"../../src/services/test-count-status-bar.js"
			);
			const bar = new TestCountStatusBar();
			const count = await bar.refreshCount();

			expect(count).toBe(0);
			expect(mockStatusBarItem.text).toBe("CC: no workspace");
		});

		test("returns 0 and shows 'no workspace' when workspaceFolders is undefined", async () => {
			vscodeMock.workspace.isTrusted = true;
			(vscodeMock.workspace as Record<string, unknown>)["workspaceFolders"] =
				undefined;

			const { TestCountStatusBar } = await import(
				"../../src/services/test-count-status-bar.js"
			);
			const bar = new TestCountStatusBar();
			const count = await bar.refreshCount();

			expect(count).toBe(0);
			expect(mockStatusBarItem.text).toBe("CC: no workspace");
		});

		test("shows loading indicator before running tests", async () => {
			vscodeMock.workspace.isTrusted = true;
			vscodeMock.workspace.workspaceFolders = [
				{
					uri: { fsPath: "/mock/workspace" },
					name: "workspace",
					index: 0,
				},
			];

			// Mock child_process to capture the loading state
			let loadingText = "";
			mock.module("node:child_process", () => ({
				...realChildProcess,
				execFile: (
					_cmd: string,
					_args: string[],
					_opts: unknown,
					cb: (err: null, result: { stdout: string; stderr: string }) => void,
				) => {
					// Capture text while "running"
					loadingText = mockStatusBarItem.text;
					cb(null, { stdout: "", stderr: "383 pass" });
				},
			}));

			const { TestCountStatusBar } = await import(
				"../../src/services/test-count-status-bar.js"
			);
			const bar = new TestCountStatusBar();
			await bar.refreshCount();

			expect(loadingText).toBe("$(loading~spin) CC: running tests...");
		});

		test("parses pass count from successful bun test stderr", async () => {
			vscodeMock.workspace.isTrusted = true;
			vscodeMock.workspace.workspaceFolders = [
				{
					uri: { fsPath: "/mock/workspace" },
					name: "workspace",
					index: 0,
				},
			];

			mock.module("node:child_process", () => ({
				...realChildProcess,
				execFile: (
					_cmd: string,
					_args: string[],
					_opts: unknown,
					cb: (err: null, result: { stdout: string; stderr: string }) => void,
				) => {
					cb(null, {
						stdout: "",
						stderr:
							"bun test v1.2.0\n\n383 pass\n0 fail\n12 expect() calls\nRan 383 tests across 42 files",
					});
				},
			}));

			const { TestCountStatusBar } = await import(
				"../../src/services/test-count-status-bar.js"
			);
			const bar = new TestCountStatusBar();
			const count = await bar.refreshCount();

			expect(count).toBe(383);
			expect(mockStatusBarItem.text).toBe("CC: 383 tests \u2713");
		});

		test("parses pass count from failed bun test (non-zero exit) stderr", async () => {
			vscodeMock.workspace.isTrusted = true;
			vscodeMock.workspace.workspaceFolders = [
				{
					uri: { fsPath: "/mock/workspace" },
					name: "workspace",
					index: 0,
				},
			];

			mock.module("node:child_process", () => ({
				...realChildProcess,
				execFile: (
					_cmd: string,
					_args: string[],
					_opts: unknown,
					cb: (err: Error & { stderr: string }, result: null) => void,
				) => {
					const err = new Error("exit code 1") as Error & {
						stderr: string;
					};
					err.stderr =
						"bun test v1.2.0\n\n380 pass\n3 fail\nRan 383 tests across 42 files";
					cb(err, null);
				},
			}));

			const { TestCountStatusBar } = await import(
				"../../src/services/test-count-status-bar.js"
			);
			const bar = new TestCountStatusBar();
			const count = await bar.refreshCount();

			expect(count).toBe(380);
			expect(mockStatusBarItem.text).toBe("CC: 380 tests \u2713");
		});

		test("regex parses various 'N pass' patterns", () => {
			const regex = /(\d+)\s+pass/;

			// Standard bun test output
			expect(regex.exec("383 pass")?.[1]).toBe("383");
			// With extra whitespace
			expect(regex.exec("42  pass")?.[1]).toBe("42");
			// Single test
			expect(regex.exec("1 pass")?.[1]).toBe("1");
			// In longer output
			expect(regex.exec("some output\n99 pass\n0 fail")?.[1]).toBe("99");
			// No match
			expect(regex.exec("all tests failed")).toBeNull();
			expect(regex.exec("passing")).toBeNull();
		});
	});
});
