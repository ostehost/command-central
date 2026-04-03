import * as vscode from "vscode";

const AGENT_STATUS_SETTINGS_MIGRATION_VERSION = 1;
const AGENT_STATUS_SETTINGS_MIGRATION_STATE_KEY =
	"commandCentral.agentStatusSettingsMigrationVersion";

const STALE_AGENT_STATUS_KEYS = [
	"agentStatus.sortMode",
	"agentStatus.sortByStatus",
	"agentStatus.showOnlyRunning",
	"agentStatus.maxVisibleAgents",
	"agentStatus.scope",
	"agentStatus.defaultBackend",
] as const;

const AGENT_STATUS_GROUP_BY_PROJECT_KEY = "agentStatus.groupByProject";
const AGENT_STATUS_MIGRATION_MESSAGE =
	"Command Central updated Agent Status to the new grouped default view.";

type MigrationWorkspace = Pick<typeof vscode.workspace, "getConfiguration">;
type MigrationWindow = Pick<typeof vscode.window, "showInformationMessage">;
type MigrationContext = Pick<vscode.ExtensionContext, "globalState">;

interface MigrationDependencies {
	workspace: MigrationWorkspace;
	window: MigrationWindow;
}

function hasExplicitSetting(
	inspection: ReturnType<vscode.WorkspaceConfiguration["inspect"]> | undefined,
	target: vscode.ConfigurationTarget,
): boolean {
	if (target === vscode.ConfigurationTarget.Global) {
		return inspection?.globalValue !== undefined;
	}

	if (target === vscode.ConfigurationTarget.Workspace) {
		return inspection?.workspaceValue !== undefined;
	}

	return false;
}

function shouldForceGroupedView(
	inspection: ReturnType<vscode.WorkspaceConfiguration["inspect"]> | undefined,
	target: vscode.ConfigurationTarget,
): boolean {
	if (target === vscode.ConfigurationTarget.Global) {
		return inspection?.globalValue === false;
	}

	if (target === vscode.ConfigurationTarget.Workspace) {
		return inspection?.workspaceValue === false;
	}

	return false;
}

export async function migrateLegacyAgentStatusSettings(
	context: MigrationContext,
	deps: MigrationDependencies = {
		workspace: vscode.workspace,
		window: vscode.window,
	},
): Promise<boolean> {
	const currentVersion = context.globalState.get<number>(
		AGENT_STATUS_SETTINGS_MIGRATION_STATE_KEY,
		0,
	);
	if (currentVersion >= AGENT_STATUS_SETTINGS_MIGRATION_VERSION) {
		return false;
	}

	const config = deps.workspace.getConfiguration("commandCentral");
	let didMigrate = false;

	for (const key of STALE_AGENT_STATUS_KEYS) {
		const inspection = config.inspect(key);
		for (const target of [
			vscode.ConfigurationTarget.Global,
			vscode.ConfigurationTarget.Workspace,
		]) {
			if (!hasExplicitSetting(inspection, target)) {
				continue;
			}
			await config.update(key, undefined, target);
			didMigrate = true;
		}
	}

	const groupByProjectInspection = config.inspect(
		AGENT_STATUS_GROUP_BY_PROJECT_KEY,
	);
	for (const target of [
		vscode.ConfigurationTarget.Global,
		vscode.ConfigurationTarget.Workspace,
	]) {
		if (!shouldForceGroupedView(groupByProjectInspection, target)) {
			continue;
		}
		await config.update(AGENT_STATUS_GROUP_BY_PROJECT_KEY, true, target);
		didMigrate = true;
	}

	await context.globalState.update(
		AGENT_STATUS_SETTINGS_MIGRATION_STATE_KEY,
		AGENT_STATUS_SETTINGS_MIGRATION_VERSION,
	);

	if (didMigrate) {
		await deps.window.showInformationMessage(AGENT_STATUS_MIGRATION_MESSAGE);
	}

	return didMigrate;
}
