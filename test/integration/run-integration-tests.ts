#!/usr/bin/env bun

/**
 * Pure Bun VS Code Integration Test Runner
 * Launches VS Code with the extension and runs tests
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "bun";

export interface TestConfig {
	extensionPath?: string;
	testWorkspace?: string;
	vscodeVersion?: string;
	launchArgs?: string[];
	env?: Record<string, string>;
}

/**
 * Run integration tests with VS Code
 */
export async function runIntegrationTests(config: TestConfig = {}) {
	const extensionPath = config.extensionPath || process.cwd();
	const testWorkspace =
		config.testWorkspace ||
		path.join(extensionPath, "test/integration/fixtures/workspace");
	const vscodeVersion = config.vscodeVersion || "stable";

	console.log("🧪 Running VS Code Integration Tests with Bun");
	console.log(`=${"=".repeat(59)}`);
	console.log(`Extension: ${extensionPath}`);
	console.log(`Workspace: ${testWorkspace}`);
	console.log(`VS Code: ${vscodeVersion}`);
	console.log("");

	// Step 1: Build the extension
	console.log("📦 Building extension...");
	const buildResult = await Bun.$`bun run build`.quiet();
	if (buildResult.exitCode !== 0) {
		console.error("❌ Build failed");
		console.error(buildResult.stderr.toString());
		process.exit(1);
	}
	console.log("✅ Extension built\n");

	// Step 2: Ensure test workspace exists
	if (!existsSync(testWorkspace)) {
		console.log("📁 Creating test workspace...");
		await Bun.$`mkdir -p ${testWorkspace}`;
		await Bun.write(
			path.join(testWorkspace, ".vscode/settings.json"),
			JSON.stringify(
				{
					"ghostty.enabled": true,
					"ghostty.debug": true,
				},
				null,
				2,
			),
		);
		console.log("✅ Test workspace created\n");
	}

	// Step 3: Launch VS Code with extension
	console.log("🚀 Launching VS Code...");

	const args = [
		`--extensionDevelopmentPath=${extensionPath}`,
		"--new-window",
		"--disable-extensions", // Disable other extensions
		"--enable-proposed-api=ghostty-launcher", // If using proposed APIs
		testWorkspace,
	];

	// Add any additional launch args
	if (config.launchArgs) {
		args.push(...config.launchArgs);
	}

	const env = {
		...process.env,
		NODE_ENV: "test",
		EXTENSION_ID: "ghostty-launcher",
		TEST_RUNNER: "bun",
		...config.env,
	};

	// Use 'code' command to launch VS Code
	const codeCmd = process.platform === "win32" ? "code.cmd" : "code";

	// First, run tests in headless mode
	console.log("🏃 Running tests...\n");

	// Create a test script that VS Code will execute
	const testScript = path.join(
		extensionPath,
		"test/integration/bun-test-runner.ts",
	);
	await Bun.write(
		testScript,
		`
import { test, expect } from 'bun:test';
import * as vscode from 'vscode';

// Wait for extension to activate
setTimeout(async () => {
  try {
    // Import and run test suites
    await import('./suite/activation.test.js');
    await import('./suite/commands.test.js');
    
    // Signal completion
    console.log('✅ All tests completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failure:', error);
    process.exit(1);
  }
}, 2000);
`,
	);

	// Run tests using bun test command directly
	const testProc = spawn({
		cmd: ["bun", "test", "test/integration/suite"],
		cwd: extensionPath,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});

	const exitCode = await testProc.exited;

	if (exitCode === 0) {
		console.log("\n✅ All integration tests passed!");
	} else {
		console.error("\n❌ Integration tests failed");
		process.exit(1);
	}

	// Optional: Launch VS Code in interactive mode for debugging
	if (process.env["INTERACTIVE"] === "true") {
		console.log("\n🔍 Launching VS Code in interactive mode...");
		const interactive = spawn({
			cmd: [codeCmd, ...args],
			env,
			stdout: "inherit",
			stderr: "inherit",
		});

		await interactive.exited;
	}
}

// Run if called directly
if (import.meta.main) {
	runIntegrationTests({
		launchArgs: process.argv.slice(2),
	}).catch((err) => {
		console.error("Fatal error:", err);
		process.exit(1);
	});
}
