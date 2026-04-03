import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as vscode from "vscode";
import { createMockExtensionContext } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

type InspectValue = {
	key?: string;
	globalValue?: unknown;
	workspaceValue?: unknown;
};

describe("migrateLegacyAgentStatusSettings", () => {
	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();
	});

	function createGlobalState(
		initialStore: Record<string, unknown> = {},
	): vscode.ExtensionContext["globalState"] {
		const store = new Map<string, unknown>(Object.entries(initialStore));

		return {
			get: mock((key: string, defaultValue?: unknown) =>
				store.has(key) ? store.get(key) : defaultValue,
			),
			update: mock(async (key: string, value: unknown) => {
				store.set(key, value);
			}),
			keys: mock(() => Array.from(store.keys())),
			setKeysForSync: mock(),
		} as unknown as vscode.ExtensionContext["globalState"];
	}

	function createConfig(initialInspectValues: Record<string, InspectValue>) {
		const inspectValues = new Map<string, InspectValue>(
			Object.entries(initialInspectValues),
		);
		const updateCalls: Array<{
			key: string;
			value: unknown;
			target: vscode.ConfigurationTarget | undefined;
		}> = [];

		const config = {
			inspect: mock((key: string) => ({
				key,
				...(inspectValues.get(key) ?? {}),
			})),
			update: mock(
				async (
					key: string,
					value: unknown,
					target?: vscode.ConfigurationTarget,
				) => {
					updateCalls.push({ key, value, target });
					const current = inspectValues.get(key) ?? {};
					if (target === 1) {
						current.globalValue = value;
					}
					if (target === 2) {
						current.workspaceValue = value;
					}
					inspectValues.set(key, current);
				},
			),
		} as Pick<vscode.WorkspaceConfiguration, "inspect" | "update">;

		return { config, updateCalls };
	}

	test("clears stale agent status settings and restores grouped view defaults", async () => {
		const { migrateLegacyAgentStatusSettings } = await import(
			"../../src/utils/agent-status-settings-migration.js"
		);
		const globalState = createGlobalState();
		const context = createMockExtensionContext({ globalState });
		const { config, updateCalls } = createConfig({
			"agentStatus.sortMode": { globalValue: "recency" },
			"agentStatus.sortByStatus": { workspaceValue: true },
			"agentStatus.showOnlyRunning": { globalValue: false },
			"agentStatus.maxVisibleAgents": { workspaceValue: 50 },
			"agentStatus.scope": { globalValue: "all" },
			"agentStatus.defaultBackend": { workspaceValue: "claude" },
			"agentStatus.groupByProject": {
				globalValue: false,
				workspaceValue: false,
			},
		});
		const workspace = {
			getConfiguration: mock((section?: string) => {
				expect(section).toBe("commandCentral");
				return config as vscode.WorkspaceConfiguration;
			}),
		} as Pick<typeof vscode.workspace, "getConfiguration">;
		const showInformationMessage = mock(() => Promise.resolve(undefined));

		const didMigrate = await migrateLegacyAgentStatusSettings(context, {
			workspace,
			window: { showInformationMessage },
		});

		expect(didMigrate).toBe(true);
		expect(updateCalls).toEqual([
			{
				key: "agentStatus.sortMode",
				value: undefined,
				target: 1,
			},
			{
				key: "agentStatus.sortByStatus",
				value: undefined,
				target: 2,
			},
			{
				key: "agentStatus.showOnlyRunning",
				value: undefined,
				target: 1,
			},
			{
				key: "agentStatus.maxVisibleAgents",
				value: undefined,
				target: 2,
			},
			{
				key: "agentStatus.scope",
				value: undefined,
				target: 1,
			},
			{
				key: "agentStatus.defaultBackend",
				value: undefined,
				target: 2,
			},
			{
				key: "agentStatus.groupByProject",
				value: true,
				target: 1,
			},
			{
				key: "agentStatus.groupByProject",
				value: true,
				target: 2,
			},
		]);
		expect(globalState.update).toHaveBeenCalledWith(
			"commandCentral.agentStatusSettingsMigrationVersion",
			1,
		);
		expect(showInformationMessage).toHaveBeenCalledWith(
			"Command Central updated Agent Status to the new grouped default view.",
		);
	});

	test("skips the migration after the version flag is stored", async () => {
		const { migrateLegacyAgentStatusSettings } = await import(
			"../../src/utils/agent-status-settings-migration.js"
		);
		const globalState = createGlobalState({
			"commandCentral.agentStatusSettingsMigrationVersion": 1,
		});
		const context = createMockExtensionContext({ globalState });
		const { config, updateCalls } = createConfig({
			"agentStatus.sortMode": { globalValue: "recency" },
		});
		const workspace = {
			getConfiguration: mock(() => config as vscode.WorkspaceConfiguration),
		} as Pick<typeof vscode.workspace, "getConfiguration">;
		const showInformationMessage = mock(() => Promise.resolve(undefined));

		const didMigrate = await migrateLegacyAgentStatusSettings(context, {
			workspace,
			window: { showInformationMessage },
		});

		expect(didMigrate).toBe(false);
		expect(updateCalls).toHaveLength(0);
		expect(globalState.update).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	test("stores the migration version without changing clean configurations", async () => {
		const { migrateLegacyAgentStatusSettings } = await import(
			"../../src/utils/agent-status-settings-migration.js"
		);
		const globalState = createGlobalState();
		const context = createMockExtensionContext({ globalState });
		const { config, updateCalls } = createConfig({
			"agentStatus.groupByProject": { globalValue: true },
		});
		const workspace = {
			getConfiguration: mock(() => config as vscode.WorkspaceConfiguration),
		} as Pick<typeof vscode.workspace, "getConfiguration">;
		const showInformationMessage = mock(() => Promise.resolve(undefined));

		const didMigrate = await migrateLegacyAgentStatusSettings(context, {
			workspace,
			window: { showInformationMessage },
		});

		expect(didMigrate).toBe(false);
		expect(updateCalls).toHaveLength(0);
		expect(globalState.update).toHaveBeenCalledWith(
			"commandCentral.agentStatusSettingsMigrationVersion",
			1,
		);
		expect(showInformationMessage).not.toHaveBeenCalled();
	});
});
