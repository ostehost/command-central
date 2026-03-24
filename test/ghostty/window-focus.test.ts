/**
 * Window Focus Tests
 *
 * Tests lookupGhosttyTerminal and focusGhosttyWindow from
 * src/ghostty/window-focus.ts using mocked fs and child_process.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

let mockReadFileResult: { data?: string; error?: Error } = {};

mock.module("node:fs/promises", () => ({
	readFile: mock(async (_path: string, _encoding: string) => {
		if (mockReadFileResult.error) throw mockReadFileResult.error;
		return mockReadFileResult.data ?? "";
	}),
}));

type ExecFileCallback = (
	err: Error | null,
	result: { stdout: string; stderr: string },
) => void;

let execFileResults: Array<{ err: Error | null; stdout: string }> = [];
let execFileCalls: Array<{ file: string; args: string[] }> = [];

mock.module("node:child_process", () => ({
	execFile: mock(
		(
			file: string,
			args: string[],
			callback: ExecFileCallback | Record<string, unknown>,
		) => {
			execFileCalls.push({ file, args });
			const cb =
				typeof callback === "function"
					? callback
					: // promisify passes options then callback
						(arguments[3] as ExecFileCallback);
			const result = execFileResults.shift() ?? {
				err: null,
				stdout: "",
			};
			if (cb) {
				process.nextTick(() => cb(result.err, { stdout: result.stdout, stderr: "" }));
			}
		},
	),
}));

// Import after mocks are set up
const { lookupGhosttyTerminal, focusGhosttyWindow } = await import(
	"../../src/ghostty/window-focus.js"
);

beforeEach(() => {
	mockReadFileResult = {};
	execFileResults = [];
	execFileCalls = [];
});

// ── lookupGhosttyTerminal ────────────────────────────────────────────

describe("lookupGhosttyTerminal", () => {
	test("returns correct mapping when session exists in JSON", async () => {
		mockReadFileResult = {
			data: JSON.stringify({
				"agent-planner": {
					terminal_id: "4BBEDDCB-FF3F-4797-B3EE-277FA68B496F",
					window_id: "tab-group-c885ffb60",
					bundle_id: "dev.partnerai.ghostty.command-central",
				},
			}),
		};

		const result = await lookupGhosttyTerminal("agent-planner");
		expect(result).toEqual({
			terminal_id: "4BBEDDCB-FF3F-4797-B3EE-277FA68B496F",
			window_id: "tab-group-c885ffb60",
			bundle_id: "dev.partnerai.ghostty.command-central",
		});
	});

	test("returns null when session not found", async () => {
		mockReadFileResult = {
			data: JSON.stringify({
				"agent-planner": {
					terminal_id: "abc",
					window_id: "xyz",
					bundle_id: "dev.example",
				},
			}),
		};

		const result = await lookupGhosttyTerminal("agent-nonexistent");
		expect(result).toBeNull();
	});

	test("returns null when JSON file does not exist", async () => {
		mockReadFileResult = {
			error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		};

		const result = await lookupGhosttyTerminal("agent-planner");
		expect(result).toBeNull();
	});

	test("handles malformed JSON gracefully", async () => {
		mockReadFileResult = { data: "not valid json {{{" };

		const result = await lookupGhosttyTerminal("agent-planner");
		expect(result).toBeNull();
	});

	test("returns null when entry is missing required fields", async () => {
		mockReadFileResult = {
			data: JSON.stringify({
				"agent-planner": { terminal_id: "abc" },
			}),
		};

		const result = await lookupGhosttyTerminal("agent-planner");
		expect(result).toBeNull();
	});
});

// ── focusGhosttyWindow ──────────────────────────────────────────────

describe("focusGhosttyWindow", () => {
	test("calls osascript with correct bundle ID", async () => {
		// osascript succeeds
		execFileResults = [{ err: null, stdout: "" }];

		const result = await focusGhosttyWindow("com.example.ghostty");
		expect(result).toBe(true);
		expect(execFileCalls[0]?.file).toBe("osascript");
		expect(execFileCalls[0]?.args[1]).toContain("com.example.ghostty");
	});

	test("falls back to open -a when osascript fails", async () => {
		// osascript fails, then open succeeds
		execFileResults = [
			{ err: new Error("osascript failed"), stdout: "" },
			{ err: null, stdout: "" },
		];

		const result = await focusGhosttyWindow("com.example.ghostty");
		expect(result).toBe(true);
		expect(execFileCalls).toHaveLength(2);
		expect(execFileCalls[0]?.file).toBe("osascript");
		expect(execFileCalls[1]?.file).toBe("open");
		expect(execFileCalls[1]?.args).toEqual(["-a", "com.example.ghostty"]);
	});

	test("returns false when both osascript and open fail", async () => {
		execFileResults = [
			{ err: new Error("osascript failed"), stdout: "" },
			{ err: new Error("open failed"), stdout: "" },
		];

		const result = await focusGhosttyWindow("com.example.ghostty");
		expect(result).toBe(false);
	});

	test("reads terminal map and uses session data when available", async () => {
		// Terminal map has a different bundle_id for this session
		mockReadFileResult = {
			data: JSON.stringify({
				"agent-planner": {
					terminal_id: "abc",
					window_id: "xyz",
					bundle_id: "dev.partnerai.ghostty.custom",
				},
			}),
		};
		// osascript succeeds
		execFileResults = [{ err: null, stdout: "" }];

		const result = await focusGhosttyWindow(
			"com.example.ghostty",
			"agent-planner",
		);
		expect(result).toBe(true);
		// Should use the bundle_id from terminal map, not the one passed in
		expect(execFileCalls[0]?.args[1]).toContain(
			"dev.partnerai.ghostty.custom",
		);
	});

	test("uses provided bundleId when terminal map lookup fails", async () => {
		mockReadFileResult = {
			error: new Error("ENOENT"),
		};
		execFileResults = [{ err: null, stdout: "" }];

		const result = await focusGhosttyWindow(
			"com.example.ghostty",
			"agent-planner",
		);
		expect(result).toBe(true);
		expect(execFileCalls[0]?.args[1]).toContain("com.example.ghostty");
	});
});
