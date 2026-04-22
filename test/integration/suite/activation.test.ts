import assert from "node:assert/strict";
import { activateExtension, getTestApi } from "./helpers.js";

export const scenarioName = "activation";

export async function run(): Promise<void> {
	const extension = await activateExtension();
	const testApi = await getTestApi();
	const snapshot = testApi.getSnapshot();

	assert.equal(extension.id, process.env["COMMAND_CENTRAL_EXTENSION_ID"]);
	assert.ok(
		snapshot.subscriptionCount > 0,
		"Activation should register disposables in the extension context.",
	);
	assert.equal(
		snapshot.hasAgentStatusProvider,
		true,
		"Activation should initialize the agent status provider.",
	);
}
