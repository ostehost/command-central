import { describe, expect, test } from "bun:test";

type MenuContribution = {
	command?: string;
	when?: string;
	group?: string;
	icon?: string;
};

type PackageJsonShape = {
	contributes?: {
		menus?: {
			"view/item/context"?: MenuContribution[];
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

describe("package.json agent menu contributions", () => {
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
});
