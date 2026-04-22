import assert from "node:assert/strict";
import * as vscode from "vscode";
import { activateExtension, getTestApi } from "./helpers.js";

export const scenarioName = "commands registered";

// Ratified in research/CONTRACT-DECISION-test-electron-commands-registered-2026-04-21.md:
// non-generated contributed commands must register on activation, while
// generated slot commands are only required for active project slots.
const generatedSlotPattern =
	/^commandCentral\.gitSort\.(refreshView|changeSortOrder|changeFileFilter)\.slot\d+(Panel)?$/;

function isGeneratedSlotCommandForActiveSlot(
	commandId: string,
	activeSlots: string[],
): boolean {
	return activeSlots.some((slotId) => {
		const panelSuffix = `${slotId}Panel`;
		return commandId.endsWith(slotId) || commandId.endsWith(panelSuffix);
	});
}

export async function run(): Promise<void> {
	const extension = await activateExtension();
	const testApi = await getTestApi();
	const registeredCommands = new Set(await vscode.commands.getCommands(true));
	const contributedCommands = (
		extension.packageJSON as {
			contributes?: { commands?: Array<{ command?: string }> };
		}
	).contributes?.commands
		?.map((entry) => entry.command)
		.filter((command): command is string => typeof command === "string")
		.sort();

	assert.ok(
		contributedCommands && contributedCommands.length > 0,
		"Extension manifest should contribute commands.",
	);

	const activeSlots = testApi.getSnapshot().activeProjectSlots;
	assert.ok(
		activeSlots.length > 0,
		"At least one project slot should be active in the real VS Code host.",
	);

	const requiredCommands = contributedCommands.filter((command) => {
		if (!generatedSlotPattern.test(command)) {
			return true;
		}

		return isGeneratedSlotCommandForActiveSlot(command, activeSlots);
	});

	for (const command of requiredCommands) {
		assert.ok(
			registeredCommands.has(command),
			`Expected contributed command ${command} to be registered.`,
		);
	}
}
