#!/usr/bin/env bun

/**
 * VS Code Extension Integration Test Runner
 * Leverages existing validation infrastructure from scripts/
 * Following Testing Framework PRD requirements
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { validate } from "../../scripts-v2/lib/validator.js";

// Removed activation-monitor import - not needed for integration tests

// Import VS Code test electron
interface TestElectron {
	downloadAndUnzipVSCode: (version?: string) => Promise<string>;
	runTests: (options: {
		vscodeExecutablePath: string;
		extensionDevelopmentPath: string;
		extensionTestsPath: string;
		launchArgs?: string[];
		extensionTestsEnv?: Record<string, string>;
	}) => Promise<void>;
}

let testElectron: TestElectron | undefined;
try {
	// Dynamic import with proper error handling
	// @ts-expect-error - Package may not be installed, handled gracefully at runtime
	const module = await import("@vscode/test-electron");
	testElectron = module as TestElectron;
} catch (error) {
	console.error("❌ @vscode/test-electron not installed");
	console.error("   Run: bun add -d @vscode/test-electron");
	console.error(`   Error: ${error}`);
	process.exit(1);
}

if (!testElectron) {
	console.error("❌ Failed to load @vscode/test-electron");
	process.exit(1);
}

const { downloadAndUnzipVSCode, runTests } = testElectron;

export async function runIntegrationTests() {
	console.log("🧪 VS Code Extension Integration Tests");
	console.log(`=${"=".repeat(59)}`);

	// Step 1: Run pre-flight validation using existing infrastructure
	console.log("\n📋 Step 1: Pre-flight Validation");
	console.log("-".repeat(60));

	const validationResult = await validate({ level: "full" });
	if (!validationResult.passed) {
		console.error("❌ Pre-flight validation failed");
		console.error("   Integration tests require a valid extension");
		console.error("   Fix validation errors first with: just check");
		process.exit(1);
	}

	console.log("✅ Pre-flight validation passed\n");

	// Step 2: Build the extension
	console.log("📋 Step 2: Building Extension");
	console.log("-".repeat(60));

	const buildResult = await Bun.$`bun run build`.quiet();
	if (buildResult.exitCode !== 0) {
		console.error("❌ Build failed");
		console.error(buildResult.stderr.toString());
		process.exit(1);
	}

	console.log("✅ Extension built successfully\n");

	// Step 3: Set up test configuration
	const extensionDevelopmentPath = path.resolve(__dirname, "../../");
	const extensionTestsPath = path.resolve(__dirname, "./suite/index");
	const testWorkspace = path.resolve(__dirname, "./fixtures/workspace");

	// Ensure test workspace exists
	if (!existsSync(testWorkspace)) {
		await Bun.$`mkdir -p ${testWorkspace}`;
		// Create a simple test file in the workspace
		await Bun.write(
			path.join(testWorkspace, "test.txt"),
			"Test workspace for integration tests",
		);
	}

	// Test matrix configuration
	const testMatrix = [
		{ version: "stable", platform: process.platform },
		// Uncomment for full testing:
		// { version: 'insiders', platform: process.platform }
	];

	// Allow override from environment
	const vscodeVersion = process.env["VSCODE_VERSION"];
	if (vscodeVersion) {
		testMatrix.length = 0;
		testMatrix.push({ version: vscodeVersion, platform: process.platform });
	}

	console.log("📋 Step 3: Running Integration Tests");
	console.log("-".repeat(60));
	console.log(`Extension Path: ${extensionDevelopmentPath}`);
	console.log(`Test Path: ${extensionTestsPath}`);
	console.log(`Workspace: ${testWorkspace}`);
	console.log(`Test Matrix: ${testMatrix.map((t) => t.version).join(", ")}\n`);

	let allTestsPassed = true;

	for (const config of testMatrix) {
		console.log(`\n🔍 Testing against VS Code ${config.version}`);
		console.log("=".repeat(40));

		try {
			// Download VS Code if needed
			console.log("📥 Downloading VS Code...");
			const vscodeExecutablePath = await downloadAndUnzipVSCode(config.version);
			console.log(
				`✅ VS Code ${config.version} ready at: ${vscodeExecutablePath}`,
			);

			// Run the integration tests
			console.log("🏃 Running tests...");
			await runTests({
				vscodeExecutablePath,
				extensionDevelopmentPath,
				extensionTestsPath,
				launchArgs: [
					testWorkspace,
					"--disable-extensions", // Clean environment
					"--disable-gpu", // CI compatibility
					"--no-sandbox", // Docker compatibility
					// Add for debugging:
					// '--inspect-extensions=9229',
				],
				extensionTestsEnv: {
					TEST_VERSION: config.version,
					CI: process.env["CI"] || "false",
					EXTENSION_ID: "ghostty-launcher", // From package.json
				},
			});

			console.log(`✅ Tests passed for VS Code ${config.version}`);

			// Post-test activation check removed - was checking wrong VS Code instance
		} catch (err) {
			console.error(`❌ Tests failed for VS Code ${config.version}:`, err);
			allTestsPassed = false;

			// Continue testing other versions unless CI
			if (process.env["CI"] === "true") {
				process.exit(1);
			}
		}
	}

	// Final summary
	console.log(`\n${"=".repeat(60)}`);
	if (allTestsPassed) {
		console.log("✅ All integration tests passed!");
		console.log("=".repeat(60));
	} else {
		console.error("❌ Some integration tests failed");
		console.error("=".repeat(60));
		process.exit(1);
	}
}

// Run if called directly
if (import.meta.main) {
	runIntegrationTests().catch((err) => {
		console.error("Fatal error:", err);
		process.exit(1);
	});
}
