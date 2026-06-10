/**
 * Registration-shape test for the grouping activation module.
 *
 * Encodes the extraction contract for
 * src/activation/register-grouping-commands.ts: the exact command-ID set
 * (kept in sync with package.json contributes), one disposable per command,
 * and real-handler delegation through the lazy getGroupingViewManager getter
 * — including the graceful error path while the manager does not exist yet.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import packageJson from "../../package.json";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

const { registerGroupingCommands } = await import(
	"../../src/activation/register-grouping-commands.js"
);
type GroupingCommandDeps = Parameters<typeof registerGroupingCommands>[0];

const EXPECTED_COMMAND_IDS = [
	"commandCentral.grouping.toggle",
	"commandCentral.grouping.selectOption",
];

describe("registerGroupingCommands", () => {
	let registered: Map<string, (...args: unknown[]) => unknown>;
	let groupingViewManager:
		| { toggle: ReturnType<typeof mock>; selectOption: ReturnType<typeof mock> }
		| undefined;
	let telemetry: { track: ReturnType<typeof mock> };
	let logger: { error: ReturnType<typeof mock> };
	let deps: GroupingCommandDeps;

	beforeEach(() => {
		registered = new Map();
		vscodeMock.commands.registerCommand = mock(
			(id: string, handler: (...args: unknown[]) => unknown) => {
				registered.set(id, handler);
				return { dispose: mock() };
			},
		);
		vscodeMock.window.showErrorMessage = mock();
		vscodeMock.window.setStatusBarMessage = mock(() => ({ dispose: mock() }));
		groupingViewManager = {
			toggle: mock(() => Promise.resolve()),
			selectOption: mock(() => Promise.resolve()),
		};
		telemetry = { track: mock() };
		logger = { error: mock() };
		deps = {
			getGroupingViewManager: () => groupingViewManager,
			telemetry,
			logger,
		} as unknown as GroupingCommandDeps;
	});

	function handler(id: string): (...args: unknown[]) => unknown {
		const h = registered.get(id);
		if (!h) throw new Error(`Command not registered: ${id}`);
		return h;
	}

	test("registers exactly the grouping command IDs, in order, one disposable each", () => {
		const disposables = registerGroupingCommands(deps);

		expect([...registered.keys()]).toEqual(EXPECTED_COMMAND_IDS);
		expect(disposables).toHaveLength(EXPECTED_COMMAND_IDS.length);
		for (const disposable of disposables) {
			expect(typeof disposable.dispose).toBe("function");
		}
	});

	test("registered set matches the commandCentral.grouping.* commands contributed in package.json", () => {
		registerGroupingCommands(deps);

		const contributed = packageJson.contributes.commands
			.map((c: { command: string }) => c.command)
			.filter((id: string) => id.startsWith("commandCentral.grouping."));

		expect([...registered.keys()].sort()).toEqual([...contributed].sort());
	});

	test("toggle delegates to the grouping view manager", async () => {
		registerGroupingCommands(deps);

		await handler("commandCentral.grouping.toggle")();

		expect(groupingViewManager?.toggle).toHaveBeenCalledTimes(1);
	});

	test("toggle resolves the manager lazily — works once the manager appears after registration", async () => {
		const manager = groupingViewManager;
		groupingViewManager = undefined;
		registerGroupingCommands(deps);

		await handler("commandCentral.grouping.toggle")();
		expect(logger.error).toHaveBeenCalledWith(
			"Grouping view manager not initialized",
		);

		groupingViewManager = manager;
		await handler("commandCentral.grouping.toggle")();
		expect(manager?.toggle).toHaveBeenCalledTimes(1);
	});

	test("selectOption delegates, tracks telemetry, and confirms via status bar", async () => {
		registerGroupingCommands(deps);

		await handler("commandCentral.grouping.selectOption")("gitStatus");

		expect(groupingViewManager?.selectOption).toHaveBeenCalledWith("gitStatus");
		expect(telemetry.track).toHaveBeenCalledWith(
			"cc_agent_status_group_toggled",
			{ grouped: true },
		);
		expect(vscodeMock.window.setStatusBarMessage).toHaveBeenCalledWith(
			"✓ Grouping enabled: Files grouped by Git status",
			2000,
		);
	});

	test("selectOption('none') tracks grouped=false and shows the disabled message", async () => {
		registerGroupingCommands(deps);

		await handler("commandCentral.grouping.selectOption")("none");

		expect(telemetry.track).toHaveBeenCalledWith(
			"cc_agent_status_group_toggled",
			{ grouped: false },
		);
		expect(vscodeMock.window.setStatusBarMessage).toHaveBeenCalledWith(
			"✓ Grouping disabled: Files sorted by time only",
			2000,
		);
	});

	test("selectOption without a manager logs and shows the unavailable error", async () => {
		groupingViewManager = undefined;
		registerGroupingCommands(deps);

		await handler("commandCentral.grouping.selectOption")("gitStatus");

		expect(logger.error).toHaveBeenCalledWith(
			"Grouping view manager not initialized",
		);
		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Command Central: Grouping feature not available",
		);
		expect(telemetry.track).not.toHaveBeenCalled();
	});

	test("selectOption surfaces manager failures as an error message", async () => {
		groupingViewManager = {
			toggle: mock(() => Promise.resolve()),
			selectOption: mock(() => Promise.reject(new Error("boom"))),
		};
		registerGroupingCommands(deps);

		await handler("commandCentral.grouping.selectOption")("gitStatus");

		expect(logger.error).toHaveBeenCalledWith(
			"Failed to change grouping mode",
			expect.any(Error),
		);
		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Command Central: Failed to change grouping - boom",
		);
		expect(telemetry.track).not.toHaveBeenCalled();
	});
});
