/**
 * Registration-shape test for the cron feature activation module.
 *
 * Encodes the extraction contract for src/activation/cron-feature.ts:
 * the exact command-ID set (kept in sync with package.json contributes),
 * one disposable per command, and real-handler delegation to the cron
 * service / tree provider — including graceful no-ops when a command
 * fires without a job node.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import packageJson from "../../package.json";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

const { registerCronCommands } = await import(
	"../../src/activation/cron-feature.js"
);
type CronCommandDeps = Parameters<typeof registerCronCommands>[0];

const EXPECTED_COMMAND_IDS = [
	"commandCentral.cron.refresh",
	"commandCentral.cron.runNow",
	"commandCentral.cron.enable",
	"commandCentral.cron.disable",
	"commandCentral.cron.create",
	"commandCentral.cron.edit",
	"commandCentral.cron.delete",
	"commandCentral.cron.viewHistory",
];

describe("registerCronCommands", () => {
	let registered: Map<string, (...args: unknown[]) => unknown>;
	let cronService: {
		runJob: ReturnType<typeof mock>;
		enableJob: ReturnType<typeof mock>;
		disableJob: ReturnType<typeof mock>;
	};
	let cronTreeProvider: { refresh: ReturnType<typeof mock> };
	let deps: CronCommandDeps;

	beforeEach(() => {
		registered = new Map();
		vscodeMock.commands.registerCommand = mock(
			(id: string, handler: (...args: unknown[]) => unknown) => {
				registered.set(id, handler);
				return { dispose: mock() };
			},
		);
		vscodeMock.window.showInformationMessage = mock();
		cronService = {
			runJob: mock(() => Promise.resolve()),
			enableJob: mock(() => Promise.resolve()),
			disableJob: mock(() => Promise.resolve()),
		};
		cronTreeProvider = { refresh: mock() };
		deps = {
			cronService,
			cronTreeProvider,
		} as unknown as CronCommandDeps;
	});

	function handler(id: string): (...args: unknown[]) => unknown {
		const h = registered.get(id);
		if (!h) throw new Error(`Command not registered: ${id}`);
		return h;
	}

	test("registers exactly the cron command IDs, in order, one disposable each", () => {
		const disposables = registerCronCommands(deps);

		expect([...registered.keys()]).toEqual(EXPECTED_COMMAND_IDS);
		expect(disposables).toHaveLength(EXPECTED_COMMAND_IDS.length);
		for (const disposable of disposables) {
			expect(typeof disposable.dispose).toBe("function");
		}
	});

	test("registered set matches the commandCentral.cron.* commands contributed in package.json", () => {
		registerCronCommands(deps);

		const contributed = packageJson.contributes.commands
			.map((c: { command: string }) => c.command)
			.filter((id: string) => id.startsWith("commandCentral.cron."));

		expect([...registered.keys()].sort()).toEqual([...contributed].sort());
	});

	test("refresh delegates to the tree provider", () => {
		registerCronCommands(deps);

		handler("commandCentral.cron.refresh")();

		expect(cronTreeProvider.refresh).toHaveBeenCalledTimes(1);
	});

	const mutationCases = [
		["commandCentral.cron.runNow", "runJob"],
		["commandCentral.cron.enable", "enableJob"],
		["commandCentral.cron.disable", "disableJob"],
	] as const;

	for (const [commandId, method] of mutationCases) {
		test(`${commandId} calls cronService.${method} with the node's job id`, async () => {
			registerCronCommands(deps);

			await handler(commandId)({ kind: "job", job: { id: "job-1" } });

			expect(cronService[method]).toHaveBeenCalledWith("job-1");
		});

		test(`${commandId} is a graceful no-op without a job node`, async () => {
			registerCronCommands(deps);

			await handler(commandId)();
			await handler(commandId)({ kind: "summary" });
			await handler(commandId)({ kind: "job" });

			expect(cronService[method]).not.toHaveBeenCalled();
		});
	}

	const placeholderCases = [
		["commandCentral.cron.create", "Create Cron Job — coming in Phase 2"],
		["commandCentral.cron.edit", "Edit Cron Job — coming in Phase 2"],
		["commandCentral.cron.delete", "Delete Cron Job — coming in Phase 2"],
		["commandCentral.cron.viewHistory", "View Run History — coming in Phase 2"],
	] as const;

	for (const [commandId, message] of placeholderCases) {
		test(`${commandId} shows the Phase 2 placeholder toast`, () => {
			registerCronCommands(deps);

			handler(commandId)();

			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
				message,
			);
		});
	}
});
