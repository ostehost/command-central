/**
 * Registration-shape test for the OpenClaw task activation module.
 *
 * Encodes the extraction contract for
 * src/activation/register-openclaw-task-commands.ts: the exact command-ID set
 * (each contributed in package.json), one disposable per command, and
 * real-handler behavior — cancelOpenClawTask delegates to the injected
 * service and re-resolves the provider getter at invocation time, and
 * showOpenClawTaskDetail spawns a real `openclaw` CLI (PATH-shimmed to a temp
 * script) and pretty-prints its JSON into the output channel.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../../package.json";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

// Earlier suites in a mixed run install process-global
// mock.module("node:child_process") overrides that survive mock.restore()
// (e.g. test/utils/port-detector.test.ts fakes execFile with empty output).
// These tests spawn a real PATH-shimmed CLI, so re-pin the preload-stashed
// real module before every test (see test/setup/global-test-cleanup.ts).
const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");

beforeEach(() => {
	mock.module("node:child_process", () => realChildProcess);
});

const { registerOpenClawTaskCommands } = await import(
	"../../src/activation/register-openclaw-task-commands.js"
);
type OpenClawTaskCommandDeps = Parameters<
	typeof registerOpenClawTaskCommands
>[0];

const EXPECTED_COMMAND_IDS = [
	"commandCentral.cancelOpenClawTask",
	"commandCentral.showOpenClawTaskDetail",
];

describe("registerOpenClawTaskCommands", () => {
	let registered: Map<string, (...args: unknown[]) => unknown>;
	let cancelTask: ReturnType<typeof mock>;
	let provider: { reload: ReturnType<typeof mock> } | undefined;
	let openclawTaskOutputChannel: {
		clear: ReturnType<typeof mock>;
		appendLine: ReturnType<typeof mock>;
		show: ReturnType<typeof mock>;
	};
	let deps: OpenClawTaskCommandDeps;
	let tmpDirs: string[];
	let savedPath: string | undefined;

	beforeEach(() => {
		registered = new Map();
		vscodeMock.commands.registerCommand = mock(
			(id: string, handler: (...args: unknown[]) => unknown) => {
				registered.set(id, handler);
				return { dispose: mock() };
			},
		);
		vscodeMock.window.showErrorMessage = mock();
		vscodeMock.window.showWarningMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve(undefined),
		);
		cancelTask = mock(() => Promise.resolve());
		provider = undefined;
		openclawTaskOutputChannel = {
			clear: mock(),
			appendLine: mock(),
			show: mock(),
		};
		deps = {
			openclawTaskService: { cancelTask },
			getAgentStatusProvider: () => provider,
			openclawTaskOutputChannel,
		} as unknown as OpenClawTaskCommandDeps;
		tmpDirs = [];
		savedPath = process.env["PATH"];
	});

	afterEach(() => {
		process.env["PATH"] = savedPath;
		for (const dir of tmpDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function handler(id: string): (...args: unknown[]) => unknown {
		const h = registered.get(id);
		if (!h) throw new Error(`Command not registered: ${id}`);
		return h;
	}

	/**
	 * Shim a fake `openclaw` executable onto the front of PATH so the real
	 * handler's execFile("openclaw", ...) resolves to it.
	 */
	function shimOpenclawCli(body: string): string {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "openclaw-task-commands-test-"),
		);
		tmpDirs.push(dir);
		const scriptPath = path.join(dir, "openclaw");
		fs.writeFileSync(scriptPath, `#!/bin/bash\n${body}\n`, {
			encoding: "utf-8",
			mode: 0o755,
		});
		process.env["PATH"] = `${dir}:${process.env["PATH"]}`;
		return dir;
	}

	test("registers exactly the OpenClaw task command IDs, in order, one disposable each", () => {
		const disposables = registerOpenClawTaskCommands(deps);

		expect([...registered.keys()]).toEqual(EXPECTED_COMMAND_IDS);
		expect(disposables).toHaveLength(EXPECTED_COMMAND_IDS.length);
		for (const disposable of disposables) {
			expect(typeof disposable.dispose).toBe("function");
		}
	});

	test("every registered command is contributed in package.json", () => {
		registerOpenClawTaskCommands(deps);

		const contributed = packageJson.contributes.commands.map(
			(c: { command: string }) => c.command,
		);
		for (const id of registered.keys()) {
			expect(contributed).toContain(id);
		}
	});

	test("cancelOpenClawTask warns when no node is provided", async () => {
		registerOpenClawTaskCommands(deps);

		await handler("commandCentral.cancelOpenClawTask")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No background task selected. Right-click a task in the tree.",
		);
		expect(cancelTask).not.toHaveBeenCalled();
	});

	test("cancelOpenClawTask cancels via the service and reloads the provider — lazy getter contract", async () => {
		// Register while the getter still returns undefined; assign afterwards
		// to prove the handler re-resolves it at invocation time.
		registerOpenClawTaskCommands(deps);
		provider = { reload: mock() };

		await handler("commandCentral.cancelOpenClawTask")({
			type: "openclawTask",
			task: { taskId: "task-1", label: "My Task", status: "running" },
		});

		expect(cancelTask).toHaveBeenCalledWith("task-1");
		expect(provider.reload).toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Cancelled background task My Task.",
		);
	});

	test("cancelOpenClawTask falls back to the task id and tolerates a missing provider", async () => {
		registerOpenClawTaskCommands(deps);

		await handler("commandCentral.cancelOpenClawTask")({
			type: "openclawTask",
			task: { taskId: "task-2", status: "running" },
		});

		expect(cancelTask).toHaveBeenCalledWith("task-2");
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Cancelled background task task-2.",
		);
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
	});

	test("cancelOpenClawTask surfaces service failures as a user-facing error", async () => {
		cancelTask = mock(() => Promise.reject(new Error("gateway unreachable")));
		deps = {
			...deps,
			openclawTaskService: { cancelTask },
		} as unknown as OpenClawTaskCommandDeps;
		registerOpenClawTaskCommands(deps);
		provider = { reload: mock() };

		await handler("commandCentral.cancelOpenClawTask")({
			type: "openclawTask",
			task: { taskId: "task-3", status: "running" },
		});

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to cancel background task: gateway unreachable",
		);
		expect(provider.reload).not.toHaveBeenCalled();
	});

	test("showOpenClawTaskDetail warns when no node is provided", async () => {
		registerOpenClawTaskCommands(deps);

		await handler("commandCentral.showOpenClawTaskDetail")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No background task selected. Right-click a task in the tree.",
		);
	});

	test("showOpenClawTaskDetail runs the real CLI and pretty-prints JSON into the channel", async () => {
		registerOpenClawTaskCommands(deps);
		const shimDir = shimOpenclawCli(
			[
				'printf "%s %s %s %s" "$1" "$2" "$3" "$4" > "$(dirname "$0")/args.txt"',
				'echo \'{"taskId":"task-1","status":"running"}\'',
			].join("\n"),
		);

		await handler("commandCentral.showOpenClawTaskDetail")({
			type: "openclawTask",
			task: { taskId: "task-1" },
		});

		expect(fs.readFileSync(path.join(shimDir, "args.txt"), "utf-8")).toBe(
			"tasks show task-1 --json",
		);
		expect(openclawTaskOutputChannel.clear).toHaveBeenCalled();
		expect(openclawTaskOutputChannel.appendLine).toHaveBeenCalledWith(
			JSON.stringify({ taskId: "task-1", status: "running" }, null, 2),
		);
		expect(openclawTaskOutputChannel.show).toHaveBeenCalledWith(true);
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
	});

	test("showOpenClawTaskDetail shows raw output when the CLI returns non-JSON text", async () => {
		registerOpenClawTaskCommands(deps);
		shimOpenclawCli('echo "plain text status"');

		await handler("commandCentral.showOpenClawTaskDetail")({
			type: "openclawTask",
			task: { taskId: "task-1" },
		});

		expect(openclawTaskOutputChannel.appendLine).toHaveBeenCalledWith(
			"plain text status",
		);
		expect(openclawTaskOutputChannel.show).toHaveBeenCalledWith(true);
	});

	test("showOpenClawTaskDetail surfaces CLI failures as a user-facing error", async () => {
		registerOpenClawTaskCommands(deps);
		shimOpenclawCli('echo "boom" >&2; exit 1');

		await handler("commandCentral.showOpenClawTaskDetail")({
			type: "openclawTask",
			task: { taskId: "task-1" },
		});

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Failed to load background task details:"),
		);
		expect(openclawTaskOutputChannel.show).not.toHaveBeenCalled();
	});
});
