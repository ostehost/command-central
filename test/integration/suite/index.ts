import * as activation from "./activation.test.js";
import * as commandExecutes from "./command-executes.test.js";
import * as commandsRegistered from "./commands-registered.test.js";
import * as deactivation from "./deactivation.test.js";
import * as treeViewRenders from "./tree-view-renders.test.js";

interface ScenarioModule {
	scenarioName: string;
	run(): Promise<void>;
}

const scenarios: ScenarioModule[] = [
	activation,
	commandsRegistered,
	treeViewRenders,
	commandExecutes,
	deactivation,
];

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs.toFixed(0)}ms`;
	return `${(durationMs / 1000).toFixed(2)}s`;
}

export async function run(): Promise<void> {
	console.log("Running Command Central real-VS-Code scenarios...");

	for (const scenario of scenarios) {
		const start = performance.now();
		await scenario.run();
		const durationMs = performance.now() - start;
		console.log(`✓ ${scenario.scenarioName} (${formatDuration(durationMs)})`);
	}
}
