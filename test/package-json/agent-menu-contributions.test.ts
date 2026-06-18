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

const DEAD_STATUSES = [
	"stopped",
	"killed",
	"completed",
	"completed_dirty",
	"completed_stale",
	"failed",
	"contract_failure",
] as const;

function viewItemRegex(when: string | undefined): RegExp {
	const pattern = when?.match(/viewItem =~ \/(.+?)\//)?.[1];
	if (!pattern) {
		throw new Error(`not a viewItem regex when-clause: ${when}`);
	}
	return new RegExp(pattern);
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
	test("registers smartOpenFile command contribution", async () => {
		const commands = await getCommands();
		const exists = commands.some(
			(item) => item.command === "commandCentral.smartOpenFile",
		);
		expect(exists).toBe(true);
	});

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

	test("defines release-generation baseline config for launcher metadata", async () => {
		const properties = await getConfigProperties();
		const setting = properties["commandCentral.releaseGeneration.file"];
		expect(setting).toBeDefined();
		expect(setting?.default).toBe(
			"~/.config/ghostty-launcher/release-generation.json",
		);
		expect(setting?.markdownDescription).toContain("release-generation");
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

	test("adds smartOpenFile action for per-file change nodes", async () => {
		const menu = await getViewItemContextMenu();
		const smartOpen = menu.find(
			(item) =>
				item.command === "commandCentral.smartOpenFile" &&
				item.when === "viewItem == agentFileChange",
		);
		expect(smartOpen).toBeDefined();
		expect(smartOpen?.group).toBe("navigation@1");
	});

	test("adds openFileDiff context and inline actions for per-file change nodes", async () => {
		const menu = await getViewItemContextMenu();
		const contextDiff = menu.find(
			(item) =>
				item.command === "commandCentral.openFileDiff" &&
				item.when === "viewItem == agentFileChange" &&
				item.group === "navigation@2",
		);
		expect(contextDiff).toBeDefined();

		const inlineDiff = menu.find(
			(item) =>
				item.command === "commandCentral.openFileDiff" &&
				item.when === "viewItem == agentFileChange" &&
				item.group === "inline",
		);
		expect(inlineDiff).toBeDefined();
	});

	test("inline focusAgentTerminal is scoped to running rows (no dead/History rattle)", async () => {
		const menu = await getViewItemContextMenu();
		const inline = menu.find(
			(item) =>
				item.command === "commandCentral.focusAgentTerminal" &&
				item.group === "inline",
		);
		expect(inline).toBeDefined();
		const re = viewItemRegex(inline?.when);
		expect(re.test("agentTask.running")).toBe(true);
		expect(re.test("agentTask.running.linked")).toBe(true);
		for (const status of DEAD_STATUSES) {
			expect(re.test(`agentTask.${status}`)).toBe(false);
			expect(re.test(`agentTask.${status}.reviewed`)).toBe(false);
			expect(re.test(`agentTask.${status}.linked`)).toBe(false);
		}
	});

	test("inline captureAgentOutput is scoped to running rows", async () => {
		const menu = await getViewItemContextMenu();
		const inline = menu.find(
			(item) =>
				item.command === "commandCentral.captureAgentOutput" &&
				item.group === "inline",
		);
		expect(inline).toBeDefined();
		const re = viewItemRegex(inline?.when);
		expect(re.test("agentTask.running")).toBe(true);
		expect(re.test("agentTask.running.linked")).toBe(true);
		for (const status of DEAD_STATUSES) {
			expect(re.test(`agentTask.${status}`)).toBe(false);
			expect(re.test(`agentTask.${status}.reviewed`)).toBe(false);
			expect(re.test(`agentTask.${status}.linked`)).toBe(false);
		}
	});

	test("kill action matches running rows including the .linked suffix (no exact-equality blind spot)", async () => {
		// Regression: the provider appends a `.linked` contextValue suffix whenever
		// a Claude session UUID is captured (agent-status-tree-provider.ts:9351-9354).
		// A running Claude lane with a captured UUID is therefore `agentTask.running.linked`.
		// killAgent previously gated on the exact `viewItem == agentTask.running`, so
		// Kill silently vanished from exactly those (common) running lanes. Both the
		// inline and 2_actions entries must match the running prefix like the sibling
		// focus/capture/showOutput actions do.
		const menu = await getViewItemContextMenu();
		for (const group of ["inline", "2_actions"] as const) {
			const killAction = menu.find(
				(item) =>
					item.command === "commandCentral.killAgent" && item.group === group,
			);
			expect(killAction).toBeDefined();
			// Compound clause: keep the launcher + discovered-agent semantics intact.
			expect(killAction?.when).toContain("commandCentral.hasLauncher");
			expect(killAction?.when).toContain("viewItem == discoveredAgent.running");
			const re = viewItemRegex(killAction?.when);
			expect(re.test("agentTask.running")).toBe(true);
			expect(re.test("agentTask.running.linked")).toBe(true);
			for (const status of DEAD_STATUSES) {
				expect(re.test(`agentTask.${status}`)).toBe(false);
				expect(re.test(`agentTask.${status}.linked`)).toBe(false);
			}
		}
	});

	test("mark-stale-failed matches completed_stale rows including .linked/.reviewed suffixes", async () => {
		// Regression: a stale Claude lane is `agentTask.completed_stale.linked` (and
		// `.reviewed.linked` once reviewed). The exact `== agentTask.completed_stale`
		// gate dropped the inline "Mark Failed" affordance on precisely those rows.
		const menu = await getViewItemContextMenu();
		const markFailed = menu.find(
			(item) =>
				item.command === "commandCentral.markStaleAgentFailed" &&
				item.group === "inline",
		);
		expect(markFailed).toBeDefined();
		const re = viewItemRegex(markFailed?.when);
		expect(re.test("agentTask.completed_stale")).toBe(true);
		expect(re.test("agentTask.completed_stale.linked")).toBe(true);
		expect(re.test("agentTask.completed_stale.reviewed")).toBe(true);
		expect(re.test("agentTask.completed_stale.reviewed.linked")).toBe(true);
		// Must NOT bleed onto the other completed_* statuses.
		expect(re.test("agentTask.completed")).toBe(false);
		expect(re.test("agentTask.completed_dirty")).toBe(false);
	});

	test("mark-reviewed guard suppresses already-reviewed rows even with a trailing .linked suffix", async () => {
		// Regression: the negative guard was `!(viewItem =~ /\.reviewed$/)`. With the
		// `.linked` suffix appended AFTER `.reviewed`, a reviewed Claude lane is
		// `agentTask.completed.reviewed.linked` — which ends in `.linked`, not
		// `.reviewed` — so the guard failed and "Mark Reviewed" re-appeared on rows
		// already reviewed. The guard must detect `.reviewed` as a segment.
		const menu = await getViewItemContextMenu();
		const markReviewed = menu.find(
			(item) =>
				item.command === "commandCentral.markAgentReviewed" &&
				item.group === "2_actions",
		);
		expect(markReviewed).toBeDefined();
		const guard = markReviewed?.when?.match(/!\(viewItem =~ \/(.+?)\/\)/)?.[1];
		expect(guard).toBeDefined();
		const re = new RegExp(guard as string);
		// Reviewed (with or without the trailing link suffix) → guard hides the action.
		expect(re.test("agentTask.completed.reviewed")).toBe(true);
		expect(re.test("agentTask.completed.reviewed.linked")).toBe(true);
		// Not reviewed (linked or not) → guard lets the action show.
		expect(re.test("agentTask.completed")).toBe(false);
		expect(re.test("agentTask.completed.linked")).toBe(false);
	});

	test("no agentTask action gates on brittle exact-equality (must survive .linked/.reviewed suffixes)", async () => {
		// Systemic guard for the whole bug class: any `viewItem == agentTask.<status>`
		// exact match breaks the moment the provider appends a `.linked`/`.reviewed`
		// suffix. agentTask rows must always be matched by regex prefix. (Exact
		// equality against suffix-free contextValues like discoveredAgent.running or
		// projectGroup is fine — only agentTask carries the dynamic suffixes.)
		const menu = await getViewItemContextMenu();
		const offenders = menu
			.filter((item) => item.when && /==\s*agentTask\./.test(item.when))
			.map((item) => `${item.command}@${item.group}`);
		expect(offenders).toEqual([]);
	});

	test("adds view-title clear action gated by terminal-task context key", async () => {
		const menu = await getViewTitleMenu();
		const clearAction = menu.find(
			(item) =>
				item.command === "commandCentral.clearCompletedAgents" &&
				item.group === "navigation@4",
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
				item.group === "navigation@5",
		);
		expect(reapAction).toBeDefined();
		expect(reapAction?.when).toContain("view == commandCentral.agentStatus");
		expect(reapAction?.when).toContain(
			"commandCentral.agentStatus.hasTerminalTasks",
		);
	});

	test("uses agent status toolbar with filter and management buttons", async () => {
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
					item.command === "commandCentral.filterCurrentProject" &&
					item.group === "navigation@3",
			),
		).toBe(true);
		expect(
			toolbarEntries.some(
				(item) =>
					item.command === "commandCentral.clearProjectFilter" &&
					item.group === "navigation@3",
			),
		).toBe(true);
		expect(
			toolbarEntries.some(
				(item) =>
					item.command === "commandCentral.clearCompletedAgents" &&
					item.group === "navigation@4",
			),
		).toBe(true);
		expect(
			toolbarEntries.some(
				(item) =>
					item.command === "commandCentral.reapStaleAgents" &&
					item.group === "navigation@5",
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
