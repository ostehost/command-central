import { describe, expect, test } from "bun:test";

type MenuContribution = {
	command?: string;
	when?: string;
	group?: string;
	icon?: string;
};

type PackageJsonShape = {
	contributes?: {
		commands?: Array<{ command?: string }>;
		configuration?: {
			properties?: Record<
				string,
				{
					enum?: string[];
					default?: string | boolean | number;
					description?: string;
					markdownDescription?: string;
				}
			>;
		};
		menus?: {
			"view/item/context"?: MenuContribution[];
			"view/title"?: MenuContribution[];
		};
	};
};

async function getViewItemContextMenu(): Promise<MenuContribution[]> {
	const raw = await Bun.file(
		new URL("../../package.json", import.meta.url),
	).text();
	const pkg = JSON.parse(raw) as PackageJsonShape;
	return pkg.contributes?.menus?.["view/item/context"] ?? [];
}

async function getViewTitleMenu(): Promise<MenuContribution[]> {
	const raw = await Bun.file(
		new URL("../../package.json", import.meta.url),
	).text();
	const pkg = JSON.parse(raw) as PackageJsonShape;
	return pkg.contributes?.menus?.["view/title"] ?? [];
}

async function getCommands(): Promise<Array<{ command?: string }>> {
	const raw = await Bun.file(
		new URL("../../package.json", import.meta.url),
	).text();
	const pkg = JSON.parse(raw) as PackageJsonShape;
	return pkg.contributes?.commands ?? [];
}

async function getConfigProperties(): Promise<
	Record<
		string,
		{
			enum?: string[];
			default?: string | boolean | number;
			description?: string;
			markdownDescription?: string;
		}
	>
> {
	const raw = await Bun.file(
		new URL("../../package.json", import.meta.url),
	).text();
	const pkg = JSON.parse(raw) as PackageJsonShape;
	return pkg.contributes?.configuration?.properties ?? {};
}

describe("package.json agent menu contributions", () => {
	test("registers openFileDiff command contribution", async () => {
		const commands = await getCommands();
		const exists = commands.some(
			(item) => item.command === "commandCentral.openFileDiff",
		);
		expect(exists).toBe(true);
	});

	test("registers agentQuickActions command contribution", async () => {
		const commands = await getCommands();
		const exists = commands.some(
			(item) => item.command === "commandCentral.agentQuickActions",
		);
		expect(exists).toBe(true);
	});

	test("registers clearCompletedAgents command contribution", async () => {
		const commands = await getCommands();
		const exists = commands.some(
			(item) => item.command === "commandCentral.clearCompletedAgents",
		);
		expect(exists).toBe(true);
	});

	test("registers stale agent command contributions", async () => {
		const commands = await getCommands();
		expect(
			commands.some(
				(item) => item.command === "commandCentral.markStaleAgentFailed",
			),
		).toBe(true);
		expect(
			commands.some(
				(item) => item.command === "commandCentral.reapStaleAgents",
			),
		).toBe(true);
	});

	test("registers listWorktrees command contribution", async () => {
		const commands = await getCommands();
		const exists = commands.some(
			(item) => item.command === "commandCentral.listWorktrees",
		);
		expect(exists).toBe(true);
	});

	test("keeps the reduced agent status configuration surface", async () => {
		const properties = await getConfigProperties();
		expect(
			properties["commandCentral.agentStatus.autoRefreshMs"],
		).toBeDefined();
		expect(
			properties["commandCentral.agentStatus.groupByProject"],
		).toBeDefined();
		expect(
			properties["commandCentral.agentStatus.stuckThresholdMinutes"],
		).toBeDefined();
		expect(
			properties["commandCentral.agentStatus.notifications"],
		).toBeDefined();
		expect(
			properties["commandCentral.agentStatus.groupByProject"]?.default,
		).toBe(true);
		expect(
			properties["commandCentral.agentStatus.showOnlyRunning"],
		).toBeUndefined();
		expect(properties["commandCentral.agentStatus.scope"]).toBeUndefined();
		expect(properties["commandCentral.agentStatus.sortMode"]).toBeUndefined();
		expect(
			properties["commandCentral.agentStatus.maxVisibleAgents"],
		).toBeUndefined();
		expect(
			properties["commandCentral.agentStatus.sortByStatus"],
		).toBeUndefined();
		expect(
			properties["commandCentral.agentStatus.defaultBackend"],
		).toBeUndefined();
	});

	test("defines stuck threshold config with expected bounds", async () => {
		const properties = await getConfigProperties();
		const setting = properties[
			"commandCentral.agentStatus.stuckThresholdMinutes"
		] as
			| {
					default?: number;
					minimum?: number;
					maximum?: number;
					description?: string;
			  }
			| undefined;

		expect(setting).toBeDefined();
		expect(setting?.default).toBe(15);
		expect(setting?.minimum).toBe(5);
		expect(setting?.maximum).toBe(60);
		expect(setting?.description).toContain("potentially stuck");
	});

	test("defines dock bounce config enabled by default", async () => {
		const properties = await getConfigProperties();
		const setting = properties["commandCentral.dockBounce"];
		expect(setting).toBeDefined();
		expect(setting?.default).toBe(true);
		expect(setting?.description).toContain("Dock icon");
	});

	test("has inline restart action for failed launcher-managed tasks", async () => {
		const menu = await getViewItemContextMenu();
		const inlineRestart = menu.find(
			(item) =>
				item.command === "commandCentral.restartAgent" &&
				item.group === "inline",
		);

		expect(inlineRestart).toBeDefined();
		expect(inlineRestart?.when).toContain("agentTask");
		expect(inlineRestart?.when).toContain("failed");
		expect(inlineRestart?.when).toContain("commandCentral.hasLauncher");
		expect(inlineRestart?.icon).toBe("$(debug-restart)");
	});

	test("keeps context-menu restart action for completed/failed/stopped", async () => {
		const menu = await getViewItemContextMenu();
		const contextRestart = menu.find(
			(item) =>
				item.command === "commandCentral.restartAgent" &&
				item.group === "2_actions",
		);

		expect(contextRestart).toBeDefined();
		expect(contextRestart?.when).toContain(
			"completed|completed_dirty|failed|stopped",
		);
		expect(contextRestart?.when).toContain("commandCentral.hasLauncher");
	});

	test("adds openFileDiff action for per-file change nodes", async () => {
		const menu = await getViewItemContextMenu();
		const openFileDiff = menu.find(
			(item) =>
				item.command === "commandCentral.openFileDiff" &&
				item.when === "viewItem == agentFileChange",
		);
		expect(openFileDiff).toBeDefined();
		expect(openFileDiff?.group).toBe("navigation");
	});

	test("adds context-menu kill action for running agents", async () => {
		const menu = await getViewItemContextMenu();
		const runningKillAction = menu.find(
			(item) =>
				item.command === "commandCentral.killAgent" &&
				item.group === "2_actions" &&
				item.when ===
					"(viewItem == agentTask.running && commandCentral.hasLauncher) || viewItem == discoveredAgent.running",
		);
		expect(runningKillAction).toBeDefined();
	});

	test("adds view-title clear action gated by terminal-task context key", async () => {
		const menu = await getViewTitleMenu();
		const clearAction = menu.find(
			(item) =>
				item.command === "commandCentral.clearCompletedAgents" &&
				item.group === "navigation@3",
		);
		expect(clearAction).toBeDefined();
		expect(clearAction?.when).toContain("view == commandCentral.agentStatus");
		expect(clearAction?.when).toContain(
			"commandCentral.agentStatus.hasTerminalTasks",
		);
	});

	test("adds stale-reap toolbar action gated by terminal-task context key", async () => {
		const menu = await getViewTitleMenu();
		const reapAction = menu.find(
			(item) =>
				item.command === "commandCentral.reapStaleAgents" &&
				item.group === "navigation@4",
		);
		expect(reapAction).toBeDefined();
		expect(reapAction?.when).toContain("view == commandCentral.agentStatus");
		expect(reapAction?.when).toContain(
			"commandCentral.agentStatus.hasTerminalTasks",
		);
	});

	test("uses a four-button agent status toolbar", async () => {
		const menu = await getViewTitleMenu();
		const toolbarEntries = menu.filter((item) =>
			item.when?.includes("view == commandCentral.agentStatus"),
		);
		expect(
			toolbarEntries.some(
				(item) =>
					item.command === "commandCentral.refreshAgentStatus" &&
					item.group === "navigation@1",
			),
		).toBe(true);
		expect(
			toolbarEntries.some(
				(item) =>
					item.command === "commandCentral.toggleProjectGrouping" &&
					item.group === "navigation@2",
			),
		).toBe(true);
		expect(
			toolbarEntries.some(
				(item) =>
					item.command === "commandCentral.toggleProjectGroupingFlat" &&
					item.group === "navigation@2",
			),
		).toBe(true);
		expect(
			toolbarEntries.some(
				(item) =>
					item.command === "commandCentral.clearCompletedAgents" &&
					item.group === "navigation@3",
			),
		).toBe(true);
		expect(
			toolbarEntries.some(
				(item) =>
					item.command === "commandCentral.reapStaleAgents" &&
					item.group === "navigation@4",
			),
		).toBe(true);
		expect(
			toolbarEntries.some(
				(item) => item.command === "commandCentral.launchAgent",
			),
		).toBe(false);
		expect(
			toolbarEntries.some(
				(item) => item.command === "commandCentral.showDiscoveryDiagnostics",
			),
		).toBe(false);
	});
});
