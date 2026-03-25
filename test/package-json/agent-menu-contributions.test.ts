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

	test("registers switchAgentBackend command contribution", async () => {
		const commands = await getCommands();
		const exists = commands.some(
			(item) => item.command === "commandCentral.switchAgentBackend",
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

	test("registers clearTerminalTasks command contribution", async () => {
		const commands = await getCommands();
		const exists = commands.some(
			(item) => item.command === "commandCentral.clearTerminalTasks",
		);
		expect(exists).toBe(true);
	});

	test("registers listWorktrees command contribution", async () => {
		const commands = await getCommands();
		const exists = commands.some(
			(item) => item.command === "commandCentral.listWorktrees",
		);
		expect(exists).toBe(true);
	});

	test("defines defaultBackend config with codex/gemini only", async () => {
		const properties = await getConfigProperties();
		const setting = properties["commandCentral.agentStatus.defaultBackend"];
		expect(setting).toBeDefined();
		expect(setting?.default).toBe("codex");
		expect(setting?.enum).toEqual(["codex", "gemini"]);
	});

	test("defines status-priority sort config enabled by default", async () => {
		const properties = await getConfigProperties();
		const setting = properties["commandCentral.agentStatus.sortByStatus"];
		expect(setting).toBeDefined();
		expect(setting?.default).toBe(true);
		expect(setting?.description).toContain("status priority");
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
		expect(contextRestart?.when).toContain("completed|failed|stopped");
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
				item.command === "commandCentral.clearTerminalTasks" &&
				item.group === "navigation@5",
		);
		expect(clearAction).toBeDefined();
		expect(clearAction?.when).toContain("view == commandCentral.agentStatus");
		expect(clearAction?.when).toContain(
			"commandCentral.agentStatus.hasTerminalTasks",
		);
	});
});
