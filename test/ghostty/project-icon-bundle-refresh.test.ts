import { beforeEach, describe, expect, mock, test } from "bun:test";
import { refreshGhosttyBundleAfterProjectIconChange } from "../../src/ghostty/project-icon-bundle-refresh.js";

describe("refreshGhosttyBundleAfterProjectIconChange", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("does nothing when terminal manager is unavailable", async () => {
		const showWarningMessage = mock(async (_message: string) => undefined);

		await refreshGhosttyBundleAfterProjectIconChange("/tmp/project", {
			showWarningMessage,
		});

		expect(showWarningMessage).not.toHaveBeenCalled();
	});

	test("warns and skips bundle refresh when launcher is unavailable", async () => {
		const terminalManager = {
			isLauncherInstalled: mock(async () => false),
			createProjectTerminal: mock(async (_projectDir: string) => undefined),
		};
		const showWarningMessage = mock(async (_message: string) => undefined);
		const logger = { warn: mock() };

		await refreshGhosttyBundleAfterProjectIconChange("/tmp/project", {
			terminalManager,
			logger,
			showWarningMessage,
		});

		expect(terminalManager.isLauncherInstalled).toHaveBeenCalledTimes(1);
		expect(terminalManager.createProjectTerminal).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(showWarningMessage).toHaveBeenCalledTimes(1);
		expect(showWarningMessage.mock.calls[0]?.[0]).toContain(
			"Project icon was saved",
		);
	});

	test("warns but preserves flow when bundle refresh fails", async () => {
		const terminalManager = {
			isLauncherInstalled: mock(async () => true),
			createProjectTerminal: mock(async (_projectDir: string) => {
				throw new Error("create-bundle failed");
			}),
		};
		const showWarningMessage = mock(async (_message: string) => undefined);
		const logger = { warn: mock() };

		await expect(
			refreshGhosttyBundleAfterProjectIconChange("/tmp/project", {
				terminalManager,
				logger,
				showWarningMessage,
			}),
		).resolves.toBeUndefined();

		expect(terminalManager.isLauncherInstalled).toHaveBeenCalledTimes(1);
		expect(terminalManager.createProjectTerminal).toHaveBeenCalledWith(
			"/tmp/project",
		);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(showWarningMessage).toHaveBeenCalledTimes(1);
		expect(showWarningMessage.mock.calls[0]?.[0]).toContain(
			"failed to refresh",
		);
	});

	test("refreshes bundle without warning when launcher is available", async () => {
		const terminalManager = {
			isLauncherInstalled: mock(async () => true),
			createProjectTerminal: mock(async (_projectDir: string) => undefined),
		};
		const showWarningMessage = mock(async (_message: string) => undefined);
		const logger = { warn: mock() };

		await refreshGhosttyBundleAfterProjectIconChange("/tmp/project", {
			terminalManager,
			logger,
			showWarningMessage,
		});

		expect(terminalManager.isLauncherInstalled).toHaveBeenCalledTimes(1);
		expect(terminalManager.createProjectTerminal).toHaveBeenCalledWith(
			"/tmp/project",
		);
		expect(logger.warn).not.toHaveBeenCalled();
		expect(showWarningMessage).not.toHaveBeenCalled();
	});
});
