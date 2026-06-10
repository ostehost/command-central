/**
 * Registration-shape test for the agent registry mutation activation module.
 *
 * Encodes the extraction contract for
 * src/activation/register-agent-registry-commands.ts: the exact command-ID
 * set (each contributed in package.json), one disposable per command, and
 * real-handler delegation through the lazy getter deps —
 * AgentStatusTreeProvider and TerminalManager are resettable module state in
 * extension.ts, so the handlers must re-resolve the getters on every
 * invocation and degrade gracefully while a dependency is missing.
 *
 * Registry mutations run against real temp tasks.json files and capture/kill
 * run real helper scripts from a temp dir, so these tests exercise the actual
 * race-safe write path (re-read before persist, .bak backup) rather than
 * re-simulating it. Supersedes the former removeAgentTask /
 * clearCompletedAgents / stale-agent simulation blocks in
 * extension-commands.test.ts; pure registry-map helpers stay covered in
 * test/utils/agent-task-registry.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../../package.json";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

const { registerAgentRegistryCommands } = await import(
	"../../src/activation/register-agent-registry-commands.js"
);
const { STALE_AGENT_STATUS_DESCRIPTION } = await import(
	"../../src/utils/agent-task-registry.js"
);
type AgentRegistryCommandDeps = Parameters<
	typeof registerAgentRegistryCommands
>[0];

const EXPECTED_COMMAND_IDS = [
	"commandCentral.captureAgentOutput",
	"commandCentral.killAgent",
	"commandCentral.clearCompletedAgents",
	"commandCentral.markStaleAgentFailed",
	"commandCentral.reapStaleAgents",
	"commandCentral.removeAgentTask",
	"commandCentral.markAgentReviewed",
];

describe("registerAgentRegistryCommands", () => {
	let registered: Map<string, (...args: unknown[]) => unknown>;
	let statusProvider:
		| {
				filePath: string | null;
				reload: ReturnType<typeof mock>;
				getStaleLauncherTasks: ReturnType<typeof mock>;
				markTaskReviewed: ReturnType<typeof mock>;
		  }
		| undefined;
	let terminalManager:
		| { resolveLauncherHelperScriptPath: ReturnType<typeof mock> }
		| undefined;
	let agentOutputChannel: {
		clear: ReturnType<typeof mock>;
		appendLine: ReturnType<typeof mock>;
		show: ReturnType<typeof mock>;
	};
	let deps: AgentRegistryCommandDeps;
	let tmpDirs: string[];

	beforeEach(() => {
		registered = new Map();
		vscodeMock.commands.registerCommand = mock(
			(id: string, handler: (...args: unknown[]) => unknown) => {
				registered.set(id, handler);
				return { dispose: mock() };
			},
		);
		vscodeMock.window.showErrorMessage = mock();
		vscodeMock.window.showInformationMessage = mock(() =>
			Promise.resolve(undefined),
		);
		vscodeMock.window.showWarningMessage = mock(() =>
			Promise.resolve(undefined),
		);
		statusProvider = undefined;
		terminalManager = undefined;
		agentOutputChannel = { clear: mock(), appendLine: mock(), show: mock() };
		deps = {
			getAgentStatusProvider: () => statusProvider,
			getTerminalManager: () => terminalManager,
			agentOutputChannel,
		} as unknown as AgentRegistryCommandDeps;
		tmpDirs = [];
	});

	afterEach(() => {
		for (const dir of tmpDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function handler(id: string): (...args: unknown[]) => unknown {
		const h = registered.get(id);
		if (!h) throw new Error(`Command not registered: ${id}`);
		return h;
	}

	function makeTasksFile(tasks: Record<string, unknown>): string {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "agent-registry-commands-test-"),
		);
		tmpDirs.push(dir);
		const tasksFilePath = path.join(dir, "tasks.json");
		fs.writeFileSync(
			tasksFilePath,
			JSON.stringify({ version: 1, tasks }, null, 2),
			"utf-8",
		);
		return tasksFilePath;
	}

	function makeHelperScript(body: string): string {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "agent-registry-script-test-"),
		);
		tmpDirs.push(dir);
		const scriptPath = path.join(dir, "helper.sh");
		fs.writeFileSync(scriptPath, `#!/bin/bash\n${body}\n`, {
			encoding: "utf-8",
			mode: 0o755,
		});
		return scriptPath;
	}

	function providerWithFile(
		tasksFilePath: string | null,
		staleTasks: Array<{ id: string }> = [],
	) {
		return {
			filePath: tasksFilePath,
			reload: mock(),
			getStaleLauncherTasks: mock(() => staleTasks),
			markTaskReviewed: mock(),
		};
	}

	function readTasks(tasksFilePath: string): Record<string, unknown> {
		return (
			JSON.parse(fs.readFileSync(tasksFilePath, "utf-8")) as {
				tasks: Record<string, unknown>;
			}
		).tasks;
	}

	test("registers exactly the agent registry command IDs, in order, one disposable each", () => {
		const disposables = registerAgentRegistryCommands(deps);

		expect([...registered.keys()]).toEqual(EXPECTED_COMMAND_IDS);
		expect(disposables).toHaveLength(EXPECTED_COMMAND_IDS.length);
		for (const disposable of disposables) {
			expect(typeof disposable.dispose).toBe("function");
		}
	});

	test("every registered command is contributed in package.json", () => {
		registerAgentRegistryCommands(deps);

		const contributed = packageJson.contributes.commands.map(
			(c: { command: string }) => c.command,
		);
		for (const id of registered.keys()) {
			expect(contributed).toContain(id);
		}
	});

	test("captureAgentOutput warns when no node is provided", async () => {
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.captureAgentOutput")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No agent selected. Right-click an agent in the tree.",
		);
	});

	test("captureAgentOutput rejects an invalid session ID", async () => {
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.captureAgentOutput")({
			type: "task",
			task: { session_id: "bad session!" },
		});

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Invalid session ID.",
		);
	});

	test("captureAgentOutput errors while the provider is missing — graceful late-binding path", async () => {
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.captureAgentOutput")({
			type: "task",
			task: { session_id: "sess-123" },
		});

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
		);
	});

	test("captureAgentOutput streams real script output to the channel — lazy getter contract", async () => {
		// Register while both getters still return undefined; assign afterwards
		// to prove the handler re-resolves them at invocation time.
		registerAgentRegistryCommands(deps);

		const tasksFilePath = makeTasksFile({});
		statusProvider = providerWithFile(tasksFilePath);
		const scriptPath = makeHelperScript('printf "captured %s\\n" "$1"');
		terminalManager = {
			resolveLauncherHelperScriptPath: mock(() => Promise.resolve(scriptPath)),
		};

		await handler("commandCentral.captureAgentOutput")({
			type: "task",
			task: { session_id: "sess-123" },
		});

		expect(
			terminalManager.resolveLauncherHelperScriptPath,
		).toHaveBeenCalledWith("oste-capture.sh");
		expect(agentOutputChannel.clear).toHaveBeenCalled();
		expect(agentOutputChannel.appendLine).toHaveBeenCalledWith(
			"=== Output: sess-123 ===",
		);
		expect(agentOutputChannel.appendLine).toHaveBeenCalledWith(
			"captured sess-123\n",
		);
		expect(agentOutputChannel.show).toHaveBeenCalledWith(true);
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
	});

	test("captureAgentOutput surfaces a missing terminal manager as a capture failure", async () => {
		statusProvider = providerWithFile(makeTasksFile({}));
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.captureAgentOutput")({
			type: "task",
			task: { session_id: "sess-123" },
		});

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to capture output: Terminal manager is not initialized.",
		);
		expect(agentOutputChannel.show).not.toHaveBeenCalled();
	});

	test("killAgent warns when no node is provided", async () => {
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.killAgent")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No agent selected. Right-click an agent in the tree.",
		);
	});

	test("killAgent discovered-agent path stops when confirmation is declined", async () => {
		statusProvider = providerWithFile(makeTasksFile({}));
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.killAgent")({
			type: "agent",
			agent: { pid: 12345, projectDir: "/tmp/project-a" },
		});

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			'Kill discovered agent "project-a" (PID 12345)?',
			{ modal: true },
			"Kill",
		);
		expect(statusProvider.reload).not.toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
	});

	test("killAgent launcher-task path runs the real kill script after confirmation", async () => {
		const tasksFilePath = makeTasksFile({});
		statusProvider = providerWithFile(tasksFilePath);
		const markerPath = path.join(path.dirname(tasksFilePath), "killed-arg");
		const scriptPath = makeHelperScript(`printf "%s" "$1" > "${markerPath}"`);
		terminalManager = {
			resolveLauncherHelperScriptPath: mock(() => Promise.resolve(scriptPath)),
		};
		vscodeMock.window.showWarningMessage = mock(() => Promise.resolve("Kill"));
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.killAgent")({
			type: "task",
			task: { id: "task-1", session_id: "sess-123" },
		});

		expect(
			terminalManager.resolveLauncherHelperScriptPath,
		).toHaveBeenCalledWith("oste-kill.sh");
		expect(fs.readFileSync(markerPath, "utf-8")).toBe("sess-123");
		expect(statusProvider.reload).toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			'Agent "task-1" killed.',
		);
	});

	test("killAgent rejects an invalid launcher-task session ID before prompting", async () => {
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.killAgent")({
			type: "task",
			task: { id: "task-1", session_id: "bad session!" },
		});

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Invalid session ID.",
		);
		expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
	});

	test("clearCompletedAgents errors while the provider is missing", async () => {
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.clearCompletedAgents")();

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
		);
	});

	test("clearCompletedAgents reports when nothing is clearable", async () => {
		const tasksFilePath = makeTasksFile({
			running: { id: "running", status: "running" },
			contractFailure: { id: "cf", status: "contract_failure" },
		});
		statusProvider = providerWithFile(tasksFilePath);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.clearCompletedAgents")();

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No completed agent entries to remove.",
		);
		expect(statusProvider.reload).not.toHaveBeenCalled();
	});

	test("clearCompletedAgents removes terminal-status entries from the real file with backup", async () => {
		const tasksFilePath = makeTasksFile({
			running: { id: "running", status: "running" },
			completed: { id: "completed", status: "completed" },
			failed: { id: "failed", status: "failed" },
		});
		const rawBefore = fs.readFileSync(tasksFilePath, "utf-8");
		statusProvider = providerWithFile(tasksFilePath);
		vscodeMock.window.showWarningMessage = mock(() =>
			Promise.resolve("Remove"),
		);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.clearCompletedAgents")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"Remove 2 completed agent entries?",
			{ modal: true },
			"Remove",
		);
		expect(Object.keys(readTasks(tasksFilePath))).toEqual(["running"]);
		expect(fs.readFileSync(`${tasksFilePath}.bak`, "utf-8")).toBe(rawBefore);
		expect(statusProvider.reload).toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Removed 2 completed agent entries.",
		);
	});

	test("clearCompletedAgents leaves the file untouched when confirmation is declined", async () => {
		const tasksFilePath = makeTasksFile({
			completed: { id: "completed", status: "completed" },
		});
		const rawBefore = fs.readFileSync(tasksFilePath, "utf-8");
		statusProvider = providerWithFile(tasksFilePath);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.clearCompletedAgents")();

		expect(fs.readFileSync(tasksFilePath, "utf-8")).toBe(rawBefore);
		expect(fs.existsSync(`${tasksFilePath}.bak`)).toBe(false);
		expect(statusProvider.reload).not.toHaveBeenCalled();
	});

	test("clearCompletedAgents surfaces malformed tasks.json as a user-facing error", async () => {
		const tasksFilePath = makeTasksFile({});
		fs.writeFileSync(tasksFilePath, "{ not json", "utf-8");
		statusProvider = providerWithFile(tasksFilePath);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.clearCompletedAgents")();

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to clear completed agents: tasks.json is malformed.",
		);
	});

	test("markStaleAgentFailed warns when no node is provided", async () => {
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.markStaleAgentFailed")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No agent selected. Right-click an agent in the tree.",
		);
	});

	test("markStaleAgentFailed reports when the task is not stale", async () => {
		statusProvider = providerWithFile(makeTasksFile({}));
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.markStaleAgentFailed")({
			type: "task",
			task: { id: "task-1", status: "running" },
		});

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			'Agent "task-1" is not marked stale.',
		);
	});

	test("markStaleAgentFailed marks the stale task failed in the real file", async () => {
		const tasksFilePath = makeTasksFile({
			"task-1": { id: "task-1", status: "completed_stale" },
			"task-2": { id: "task-2", status: "running" },
		});
		statusProvider = providerWithFile(tasksFilePath);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.markStaleAgentFailed")({
			type: "task",
			task: { id: "task-1", status: "completed_stale" },
		});

		const tasks = readTasks(tasksFilePath);
		expect(tasks["task-1"]).toMatchObject({
			status: "failed",
			error_message: STALE_AGENT_STATUS_DESCRIPTION,
		});
		expect(tasks["task-2"]).toEqual({ id: "task-2", status: "running" });
		expect(statusProvider.reload).toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			'Marked stale agent "task-1" as failed.',
		);
	});

	test("markStaleAgentFailed reports already-updated when the registry has no matching task", async () => {
		const tasksFilePath = makeTasksFile({
			"task-2": { id: "task-2", status: "running" },
		});
		statusProvider = providerWithFile(tasksFilePath);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.markStaleAgentFailed")({
			type: "task",
			task: { id: "task-1", status: "completed_stale" },
		});

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			'Agent "task-1" is already updated.',
		);
		expect(statusProvider.reload).not.toHaveBeenCalled();
	});

	test("reapStaleAgents reports when the provider has no stale tasks", async () => {
		statusProvider = providerWithFile(makeTasksFile({}), []);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.reapStaleAgents")();

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"No stale agents found.",
		);
	});

	test("reapStaleAgents marks every stale task failed after confirmation", async () => {
		const tasksFilePath = makeTasksFile({
			"stale-1": { id: "stale-1", status: "completed_stale" },
			"stale-2": { id: "stale-2", status: "completed_stale" },
			done: { id: "done", status: "completed" },
		});
		statusProvider = providerWithFile(tasksFilePath, [
			{ id: "stale-1" },
			{ id: "stale-2" },
		]);
		vscodeMock.window.showWarningMessage = mock(() =>
			Promise.resolve("Mark as Failed"),
		);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.reapStaleAgents")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"Found 2 stale agents. Mark as failed?",
			{ modal: true },
			"Mark as Failed",
		);
		const tasks = readTasks(tasksFilePath);
		expect(tasks["stale-1"]).toMatchObject({ status: "failed" });
		expect(tasks["stale-2"]).toMatchObject({ status: "failed" });
		expect(tasks["done"]).toEqual({ id: "done", status: "completed" });
		expect(statusProvider.reload).toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			"Marked 2 stale agents as failed.",
		);
	});

	test("removeAgentTask warns when no node is provided", async () => {
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.removeAgentTask")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No agent selected. Right-click an agent in the tree.",
		);
	});

	test("removeAgentTask removes the task from the real file with backup", async () => {
		const tasksFilePath = makeTasksFile({
			"task-1": { id: "task-1", status: "completed" },
			"task-2": { id: "task-2", status: "failed" },
		});
		const rawBefore = fs.readFileSync(tasksFilePath, "utf-8");
		statusProvider = providerWithFile(tasksFilePath);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.removeAgentTask")({
			type: "task",
			task: { id: "task-1", status: "completed" },
		});

		expect(Object.keys(readTasks(tasksFilePath))).toEqual(["task-2"]);
		expect(fs.readFileSync(`${tasksFilePath}.bak`, "utf-8")).toBe(rawBefore);
		expect(statusProvider.reload).toHaveBeenCalled();
		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			'Removed agent "task-1".',
		);
	});

	test("removeAgentTask reports when the task is already removed", async () => {
		const tasksFilePath = makeTasksFile({
			"task-2": { id: "task-2", status: "failed" },
		});
		statusProvider = providerWithFile(tasksFilePath);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.removeAgentTask")({
			type: "task",
			task: { id: "task-1", status: "completed" },
		});

		expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
			'Agent "task-1" is already removed.',
		);
		expect(statusProvider.reload).not.toHaveBeenCalled();
	});

	test("removeAgentTask surfaces malformed tasks.json as a user-facing error", async () => {
		const tasksFilePath = makeTasksFile({});
		fs.writeFileSync(tasksFilePath, "{ not json", "utf-8");
		statusProvider = providerWithFile(tasksFilePath);
		registerAgentRegistryCommands(deps);

		await handler("commandCentral.removeAgentTask")({
			type: "task",
			task: { id: "task-1", status: "completed" },
		});

		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Failed to remove agent: tasks.json is malformed.",
		);
	});

	test("markAgentReviewed warns when no node is provided", () => {
		registerAgentRegistryCommands(deps);

		handler("commandCentral.markAgentReviewed")();

		expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
			"No agent selected. Right-click an agent in the tree.",
		);
	});

	test("markAgentReviewed delegates to the provider and is a no-op while it is missing", () => {
		registerAgentRegistryCommands(deps);

		// Provider missing: graceful no-op, no crash.
		handler("commandCentral.markAgentReviewed")({
			type: "task",
			task: { id: "task-1", status: "completed" },
		});

		statusProvider = providerWithFile(null);
		handler("commandCentral.markAgentReviewed")({
			type: "task",
			task: { id: "task-1", status: "completed" },
		});

		expect(statusProvider.markTaskReviewed).toHaveBeenCalledWith("task-1");
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
	});
});
