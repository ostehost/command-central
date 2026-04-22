import assert from "node:assert/strict";
import { getTestApi } from "./helpers.js";

export const scenarioName = "deactivation cleanup";

export async function run(): Promise<void> {
	const testApi = await getTestApi();
	const result = await testApi.deactivateForTest();

	assert.ok(
		result.before.subscriptionCount > 0,
		"Activation should register subscriptions before deactivation.",
	);
	assert.equal(
		result.after.subscriptionCount,
		0,
		"Deactivation should leave no context subscriptions behind.",
	);
	assert.equal(
		result.after.hasAgentStatusProvider,
		false,
		"Deactivation should clear the agent status provider reference.",
	);
	assert.equal(
		result.after.hasProjectViewManager,
		false,
		"Deactivation should clear the project view manager reference.",
	);
	assert.equal(
		result.after.hasProjectIconService,
		false,
		"Deactivation should clear the project icon service reference.",
	);
	assert.equal(
		result.after.hasExtensionFilterViewManager,
		false,
		"Deactivation should clear the extension filter manager reference.",
	);
	assert.equal(
		result.after.hasGroupingStateManager,
		false,
		"Deactivation should clear the grouping state manager reference.",
	);
	assert.equal(
		result.after.hasGroupingViewManager,
		false,
		"Deactivation should clear the grouping view manager reference.",
	);
	assert.equal(
		result.after.hasTerminalManager,
		false,
		"Deactivation should clear the terminal manager reference.",
	);
	assert.equal(
		result.after.hasBinaryManager,
		false,
		"Deactivation should clear the binary manager reference.",
	);
	assert.equal(
		result.after.hasTestCountStatusBar,
		false,
		"Deactivation should clear the test count status bar reference.",
	);
}
