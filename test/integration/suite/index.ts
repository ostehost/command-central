/**
 * Integration Test Suite Loader
 * Configures and runs all integration tests using Bun
 */

// Import all test files
import "./activation.test.js";
import "./commands.test.js";
import "./configuration.test.js";
import "./security.test.js";

export async function run(): Promise<void> {
	console.log("Running VS Code integration tests with Bun...");

	// Test files are already imported above and will run automatically
	// when Bun's test runner executes this file

	// Return a promise that resolves when tests complete
	return Promise.resolve();
}
