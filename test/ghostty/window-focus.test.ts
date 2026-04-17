/**
 * Window Focus Tests
 *
 * Tests launcher-aware focus helpers from src/ghostty/window-focus.ts using
 * mocked fs, child_process, and vscode configuration.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

type ExecFileCallback = (
	err: Error | null,
	result: { stdout: string; stderr: string },
) => void;

let existingPaths = new Set<string>();
let configuredLauncherPath: string | null = null;
let execFileResults: Array<{ err: Error | null; stdout: string }> = [];
let execFileCalls: Array<{ file: string; args: string[] }> = [];

const defaultFocusScriptPath = path.join(
	os.homedir(),
	"projects",
	"ghostty-launcher",
	"scripts",
	"oste-focus.applescript",
);

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
const {
	focusGhosttyWindowBySession,
	focusGhosttyBundleAndTmuxWindow,
	lookupLauncherFocusScript,
} = (await import(windowFocusModulePath)) as WindowFocusModule;

beforeEach(() => {
	existingPaths = new Set();
	configuredLauncherPath = null;
	execFileResults = [];
	execFileCalls = [];
});

describe("lookupLauncherFocusScript", () => {
	test("returns the default launcher script path when it exists", () => {
		const expected = defaultFocusScriptPath;
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
		const scriptPath = defaultFocusScriptPath;
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
		const scriptPath = defaultFocusScriptPath;
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

	test("falls back to opening the launcher app when osascript fails (legacy)", async () => {
		const scriptPath = defaultFocusScriptPath;
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

describe("focusGhosttyBundleAndTmuxWindow", () => {
	test("launcher bundle ID → open -a /Applications/Projects/<id>.app + tmux select-window", async () => {
		execFileResults = [
			{ err: null, stdout: "" }, // open -a
			{ err: null, stdout: "" }, // tmux select-window
		];

		const result = await focusGhosttyBundleAndTmuxWindow(
			"dev.partnerai.ghostty.command-central",
			{ windowId: "@22", sessionId: "agent-command-central" },
		);

		expect(result).toBe(true);
		expect(execFileCalls).toHaveLength(2);
		expect(execFileCalls[0]).toEqual({
			file: "open",
			args: ["-a", "/Applications/Projects/command-central.app"],
		});
		expect(execFileCalls[1]).toEqual({
			file: "tmux",
			args: ["select-window", "-t", "@22"],
		});
	});

	test("uses tmux socket when provided", async () => {
		execFileResults = [
			{ err: null, stdout: "" }, // open -a
			{ err: null, stdout: "" }, // tmux select-window
		];

		const result = await focusGhosttyBundleAndTmuxWindow(
			"dev.partnerai.ghostty.command-central",
			{
				socket:
					"/home/user/.local/state/ghostty-launcher/tmux/command-central.sock",
				windowId: "@22",
			},
		);

		expect(result).toBe(true);
		expect(execFileCalls[1]).toEqual({
			file: "tmux",
			args: [
				"-S",
				"/home/user/.local/state/ghostty-launcher/tmux/command-central.sock",
				"select-window",
				"-t",
				"@22",
			],
		});
	});

	test("falls back to sessionId when no windowId provided", async () => {
		execFileResults = [
			{ err: null, stdout: "" }, // open -a
			{ err: null, stdout: "" }, // tmux select-window
		];

		const result = await focusGhosttyBundleAndTmuxWindow(
			"dev.partnerai.ghostty.command-central",
			{ sessionId: "agent-command-central" },
		);

		expect(result).toBe(true);
		expect(execFileCalls[1]).toEqual({
			file: "tmux",
			args: ["select-window", "-t", "agent-command-central"],
		});
	});

	test("skips tmux when no target provided", async () => {
		execFileResults = [{ err: null, stdout: "" }]; // open -a only

		const result = await focusGhosttyBundleAndTmuxWindow(
			"dev.partnerai.ghostty.command-central",
		);

		expect(result).toBe(true);
		expect(execFileCalls).toHaveLength(1);
		expect(execFileCalls[0]?.file).toBe("open");
	});

	test("returns false and skips tmux when app focus fails", async () => {
		execFileResults = [{ err: new Error("open failed"), stdout: "" }];

		const result = await focusGhosttyBundleAndTmuxWindow(
			"dev.partnerai.ghostty.command-central",
			{ windowId: "@22" },
		);

		expect(result).toBe(false);
		expect(execFileCalls).toHaveLength(1);
		expect(execFileCalls[0]?.file).toBe("open");
	});

	test("returns true even when tmux select-window fails", async () => {
		execFileResults = [
			{ err: null, stdout: "" }, // open -a succeeds
			{ err: new Error("tmux failed"), stdout: "" }, // tmux fails
		];

		const result = await focusGhosttyBundleAndTmuxWindow(
			"dev.partnerai.ghostty.command-central",
			{ windowId: "@22" },
		);

		expect(result).toBe(true); // app was focused; tmux failure is non-fatal
	});

	test("bundle path → open -a with path directly + tmux select-window", async () => {
		execFileResults = [
			{ err: null, stdout: "" }, // open -a
			{ err: null, stdout: "" }, // tmux select-window
		];

		const result = await focusGhosttyBundleAndTmuxWindow(
			"/Applications/Projects/my-project.app",
			{ windowId: "@5" },
		);

		expect(result).toBe(true);
		expect(execFileCalls[0]).toEqual({
			file: "open",
			args: ["-a", "/Applications/Projects/my-project.app"],
		});
		expect(execFileCalls[1]).toEqual({
			file: "tmux",
			args: ["select-window", "-t", "@5"],
		});
	});

	test("does NOT invoke osascript (no System Events dependency)", async () => {
		execFileResults = [{ err: null, stdout: "" }];

		await focusGhosttyBundleAndTmuxWindow(
			"dev.partnerai.ghostty.command-central",
			{ sessionId: "agent-command-central" },
		);

		expect(execFileCalls.every((c) => c.file !== "osascript")).toBe(true);
	});
});
