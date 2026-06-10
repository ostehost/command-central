/**
 * Registration-shape test for the misc-singles activation module.
 *
 * Encodes the extraction contract for
 * src/activation/register-misc-commands.ts: the exact command-ID set (each
 * contributed in package.json), one disposable per command, and real-handler
 * delegation — including the getTestCountStatusBar late-binding contract:
 * the status bar is constructed near the end of activation, long after the
 * command registers, so the handler must re-resolve the getter on every
 * invocation and no-op gracefully while the status bar does not exist.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import packageJson from "../../package.json";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

const { registerMiscCommands } = await import(
	"../../src/activation/register-misc-commands.js"
);
type MiscCommandDeps = Parameters<typeof registerMiscCommands>[0];

const EXPECTED_COMMAND_IDS = [
	"commandCentral.copyToClipboard",
	"commandCentral.openInfrastructureDashboard",
	"command-central.showTestCount",
];

describe("registerMiscCommands", () => {
	let registered: Map<string, (...args: unknown[]) => unknown>;
	let testCountStatusBar: { refreshCount: ReturnType<typeof mock> } | undefined;
	let logger: { error: ReturnType<typeof mock> };
	let deps: MiscCommandDeps;

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
		vscodeMock.env.openExternal = mock(() => Promise.resolve(true));
		vscodeMock.env.clipboard.writeText = mock(() => Promise.resolve());
		testCountStatusBar = undefined;
		logger = { error: mock() };
		deps = {
			getTestCountStatusBar: () => testCountStatusBar,
			logger,
		} as unknown as MiscCommandDeps;
	});

	function handler(id: string): (...args: unknown[]) => unknown {
		const h = registered.get(id);
		if (!h) throw new Error(`Command not registered: ${id}`);
		return h;
	}

	test("registers exactly the misc command IDs, in order, one disposable each", () => {
		const disposables = registerMiscCommands(deps);

		expect([...registered.keys()]).toEqual(EXPECTED_COMMAND_IDS);
		expect(disposables).toHaveLength(EXPECTED_COMMAND_IDS.length);
		for (const disposable of disposables) {
			expect(typeof disposable.dispose).toBe("function");
		}
	});

	test("every registered command is contributed in package.json", () => {
		registerMiscCommands(deps);

		const contributed = packageJson.contributes.commands.map(
			(c: { command: string }) => c.command,
		);
		for (const id of registered.keys()) {
			expect(contributed).toContain(id);
		}
	});

	test("copyToClipboard writes the given text", async () => {
		registerMiscCommands(deps);

		await handler("commandCentral.copyToClipboard")("hello");

		expect(vscodeMock.env.clipboard.writeText).toHaveBeenCalledWith("hello");
	});

	test("copyToClipboard is a graceful no-op for empty text", async () => {
		registerMiscCommands(deps);

		await handler("commandCentral.copyToClipboard")("");
		await handler("commandCentral.copyToClipboard")(undefined);

		expect(vscodeMock.env.clipboard.writeText).not.toHaveBeenCalled();
	});

	test("openInfrastructureDashboard opens the dashboard URL externally", async () => {
		registerMiscCommands(deps);

		await handler("commandCentral.openInfrastructureDashboard")();

		expect(vscodeMock.env.openExternal).toHaveBeenCalledTimes(1);
		const [uri] = (vscodeMock.env.openExternal as ReturnType<typeof mock>).mock
			.calls[0] as [{ fsPath: string }];
		expect(uri.fsPath).toBe("https://dashboard.partnerai.dev");
	});

	test("showTestCount resolves the status bar lazily — late-binding contract", async () => {
		// Registration happens long before the test-count status bar is
		// constructed in activate(); until then the handler must no-op.
		registerMiscCommands(deps);

		await handler("command-central.showTestCount")();
		expect(vscodeMock.window.setStatusBarMessage).not.toHaveBeenCalled();
		expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();

		testCountStatusBar = { refreshCount: mock(() => Promise.resolve(42)) };
		await handler("command-central.showTestCount")();

		expect(testCountStatusBar.refreshCount).toHaveBeenCalledTimes(1);
		expect(vscodeMock.window.setStatusBarMessage).toHaveBeenCalledWith(
			"CC: 42 tests passed",
			3000,
		);
	});

	test("showTestCount surfaces refresh failures as an error message", async () => {
		testCountStatusBar = {
			refreshCount: mock(() => Promise.reject(new Error("boom"))),
		};
		registerMiscCommands(deps);

		await handler("command-central.showTestCount")();

		expect(logger.error).toHaveBeenCalledWith(
			"Failed to refresh test count",
			expect.any(Error),
		);
		expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
			"Command Central: Failed to run tests — boom",
		);
	});
});
