import assert from "node:assert/strict";
import * as vscode from "vscode";

export interface CommandCentralIntegrationSnapshot {
	subscriptionCount: number;
	hasAgentStatusProvider: boolean;
	hasProjectViewManager: boolean;
	hasProjectIconService: boolean;
	hasExtensionFilterViewManager: boolean;
	hasGroupingStateManager: boolean;
	hasGroupingViewManager: boolean;
	hasTerminalManager: boolean;
	hasBinaryManager: boolean;
	hasTestCountStatusBar: boolean;
	activeProjectSlots: string[];
}

export interface CommandCentralAgentStatusSnapshot {
	rootChildrenCount: number;
	taskCount: number;
}

export interface CommandCentralIntegrationDeactivationSnapshot {
	before: CommandCentralIntegrationSnapshot;
	after: CommandCentralIntegrationSnapshot;
}

export interface CommandCentralIntegrationTestApi {
	kind: "command-central-test-api";
	getSnapshot(): CommandCentralIntegrationSnapshot;
	getAgentStatusSnapshot(): CommandCentralAgentStatusSnapshot;
	deactivateForTest(): Promise<CommandCentralIntegrationDeactivationSnapshot>;
}

function getExtensionId(): string {
	const extensionId = process.env["COMMAND_CENTRAL_EXTENSION_ID"];
	assert.ok(
		extensionId,
		"COMMAND_CENTRAL_EXTENSION_ID must be provided to the VS Code test host.",
	);
	return extensionId;
}

export async function waitForIdleTurn(): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}

export async function activateExtension(): Promise<
	vscode.Extension<CommandCentralIntegrationTestApi>
> {
	const extensionId = getExtensionId();
	const extension =
		vscode.extensions.getExtension<CommandCentralIntegrationTestApi>(
			extensionId,
		);
	assert.ok(
		extension,
		`Extension ${extensionId} must be present in the VS Code test host.`,
	);

	const testApi = (await extension.activate()) as
		| CommandCentralIntegrationTestApi
		| undefined;
	assert.equal(
		extension.isActive,
		true,
		`Extension ${extension.id} must activate successfully.`,
	);
	assert.ok(
		testApi?.kind === "command-central-test-api",
		"Extension must expose the Command Central integration test API in test mode.",
	);

	return extension;
}

export async function getTestApi(): Promise<CommandCentralIntegrationTestApi> {
	const extension = await activateExtension();
	const testApi = extension.exports as
		| CommandCentralIntegrationTestApi
		| undefined;
	assert.ok(
		testApi?.kind === "command-central-test-api",
		"Extension exports must expose the Command Central integration test API.",
	);
	return testApi;
}
