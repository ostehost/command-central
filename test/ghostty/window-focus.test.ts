/**
 * Window Focus Tests
 *
 * Tests launcher-aware focus helpers from src/ghostty/window-focus.ts using
 * mocked fs, child_process, and vscode configuration.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type ExecFileCallback = (
	err: Error | null,
	result: { stdout: string; stderr: string },
) => void;

let existingPaths = new Set<string>();
let configuredLauncherPath: string | null = null;
let execFileResults: Array<{ err: Error | null; stdout: string }> = [];
let execFileCalls: Array<{ file: string; args: string[] }> = [];

mock.module("node:fs", () => ({
	existsSync: mock((candidate: string) => existingPaths.has(candidate)),
}));

mock.module("vscode", () => ({
	workspace: {
		getConfiguration: mock((_section: string) => ({
			get: mock((key: string) =>
				key === "ghostty.launcherPath" ? configuredLauncherPath : undefined,
			),
		})),
	},
}));

mock.module("node:child_process", () => ({
	execFile: mock(
		(
			file: string,
			args: string[],
			callback: ExecFileCallback | Record<string, unknown>,
			...rest: unknown[]
		) => {
			execFileCalls.push({ file, args });
			const cb =
				typeof callback === "function"
					? callback
					: (rest[0] as ExecFileCallback);
			const result = execFileResults.shift() ?? {
				err: null,
				stdout: "",
			};
			if (cb) {
				process.nextTick(() =>
					cb(result.err, { stdout: result.stdout, stderr: "" }),
				);
			}
		},
	),
}));

type WindowFocusModule = typeof import("../../src/ghostty/window-focus.js");
const windowFocusModulePath = [
	"../../src/ghostty/window-focus.js",
	"window-focus-test",
].join("?");
const { focusGhosttyWindowBySession, lookupLauncherFocusScript } =
	(await import(windowFocusModulePath)) as WindowFocusModule;

beforeEach(() => {
	existingPaths = new Set();
	configuredLauncherPath = null;
	execFileResults = [];
	execFileCalls = [];
});

describe("lookupLauncherFocusScript", () => {
	test("returns the default launcher script path when it exists", () => {
		const expected =
			"/Users/ostemini/projects/ghostty-launcher/scripts/oste-focus.applescript";
		existingPaths.add(expected);

		expect(lookupLauncherFocusScript()).toBe(expected);
	});

	test("returns null when no launcher focus script is found", () => {
		expect(lookupLauncherFocusScript()).toBeNull();
	});

	test("falls back to the configured launcher path when the default path is missing", () => {
		configuredLauncherPath = "/custom/tools/launcher";
		const expected = "/custom/tools/scripts/oste-focus.applescript";
		existingPaths.add(expected);

		expect(lookupLauncherFocusScript()).toBe(expected);
	});
});

describe("focusGhosttyWindowBySession", () => {
	test("calls osascript with launcher bundle ID and session ID", async () => {
		const scriptPath =
			"/Users/ostemini/projects/ghostty-launcher/scripts/oste-focus.applescript";
		existingPaths.add(scriptPath);
		execFileResults = [{ err: null, stdout: "" }];

		const result = await focusGhosttyWindowBySession(
			"dev.partnerai.ghostty.command-central",
			"agent-planner",
		);

		expect(result).toBe(true);
		expect(execFileCalls).toHaveLength(1);
		expect(execFileCalls[0]).toEqual({
			file: "osascript",
			args: [
				scriptPath,
				"dev.partnerai.ghostty.command-central",
				"agent-planner",
			],
		});
	});

	test("falls back to open -a for stock Ghostty bundle IDs", async () => {
		execFileResults = [{ err: null, stdout: "" }];

		const result = await focusGhosttyWindowBySession("com.mitchellh.ghostty");

		expect(result).toBe(true);
		expect(execFileCalls).toHaveLength(1);
		expect(execFileCalls[0]).toEqual({
			file: "open",
			args: ["-a", "com.mitchellh.ghostty"],
		});
	});

	test("falls back to open -a when the launcher script is missing", async () => {
		execFileResults = [{ err: null, stdout: "" }];

		const result = await focusGhosttyWindowBySession(
			"dev.partnerai.ghostty.command-central",
			"agent-planner",
		);

		expect(result).toBe(true);
		expect(execFileCalls).toHaveLength(1);
		expect(execFileCalls[0]).toEqual({
			file: "open",
			args: ["-a", "/Applications/Projects/command-central.app"],
		});
	});

	test("activates the launcher app without window matching when no session ID is provided", async () => {
		const scriptPath =
			"/Users/ostemini/projects/ghostty-launcher/scripts/oste-focus.applescript";
		existingPaths.add(scriptPath);
		execFileResults = [{ err: null, stdout: "" }];

		const result = await focusGhosttyWindowBySession(
			"dev.partnerai.ghostty.command-central",
		);

		expect(result).toBe(true);
		expect(execFileCalls).toHaveLength(1);
		expect(execFileCalls[0]).toEqual({
			file: "osascript",
			args: [scriptPath, "dev.partnerai.ghostty.command-central"],
		});
	});

	test("falls back to opening the launcher app when osascript fails", async () => {
		const scriptPath =
			"/Users/ostemini/projects/ghostty-launcher/scripts/oste-focus.applescript";
		existingPaths.add(scriptPath);
		execFileResults = [
			{ err: new Error("osascript failed"), stdout: "" },
			{ err: null, stdout: "" },
		];

		const result = await focusGhosttyWindowBySession(
			"dev.partnerai.ghostty.command-central",
			"agent-planner",
		);

		expect(result).toBe(true);
		expect(execFileCalls).toHaveLength(2);
		expect(execFileCalls[0]?.file).toBe("osascript");
		expect(execFileCalls[1]).toEqual({
			file: "open",
			args: ["-a", "/Applications/Projects/command-central.app"],
		});
	});
});
