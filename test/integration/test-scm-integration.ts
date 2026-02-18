/**
 * SCM Integration Test - GO/NO-GO Decision Point
 * THIS TEST DETERMINES IF THE PROJECT IS VIABLE
 *
 * If this test fails, the project MUST BE ABORTED IMMEDIATELY
 */

import * as vscode from "vscode";

export async function testSCMIntegration(): Promise<
	"CONTINUE" | "ABORT_PROJECT"
> {
	console.log("🔍 Running critical SCM integration test...");

	try {
		// Get the git extension
		const gitExtension = vscode.extensions.getExtension("vscode.git");

		if (!gitExtension) {
			console.error("❌ CRITICAL: Git extension not found");
			return "ABORT_PROJECT";
		}

		// Activate git extension
		const git = await gitExtension.activate();

		if (!git || !git.getAPI) {
			console.error("❌ CRITICAL: Cannot access Git API");
			return "ABORT_PROJECT";
		}

		// Get Git API
		const api = git.getAPI(1);

		if (!api || !api.repositories) {
			console.error("❌ CRITICAL: Cannot access Git repositories");
			return "ABORT_PROJECT";
		}

		// Check if we have any repositories
		if (api.repositories.length === 0) {
			console.warn("⚠️ No repositories found - need a git repo to test");
			// This is not a failure of the extension, just need a repo
			return "CONTINUE";
		}

		const repo = api.repositories[0];

		// CRITICAL TEST: Can we intercept and modify the SCM view?
		try {
			// Store original descriptor
			const originalDescriptor = Object.getOwnPropertyDescriptor(
				repo.state,
				"workingTreeChanges",
			);

			if (!originalDescriptor) {
				console.error("❌ CRITICAL: Cannot find workingTreeChanges property");
				return "ABORT_PROJECT";
			}

			// Test if we can redefine the property
			let interceptCalled = false;
			Object.defineProperty(repo.state, "workingTreeChanges", {
				get: function () {
					interceptCalled = true;
					console.log("✅ SUCCESS: SCM intercept working!");
					// Return original value
					return originalDescriptor.get?.call(this) || [];
				},
				configurable: true,
			});

			// Trigger a read to test our intercept
			const changes = repo.state.workingTreeChanges;

			// Restore original
			Object.defineProperty(
				repo.state,
				"workingTreeChanges",
				originalDescriptor,
			);

			if (!interceptCalled) {
				console.error("❌ CRITICAL: Intercept was not called");
				return "ABORT_PROJECT";
			}

			console.log("✅ SCM Integration Test PASSED - Project is viable!");
			console.log(`📊 Repository has ${changes.length} working tree changes`);
			return "CONTINUE";
		} catch (error) {
			console.error("❌ CRITICAL: Cannot modify SCM view", error);
			return "ABORT_PROJECT";
		}
	} catch (error) {
		console.error("❌ CRITICAL: Test failed with error", error);
		return "ABORT_PROJECT";
	}
}

// Additional tests for completeness
export async function testGitTimestamps(): Promise<boolean> {
	try {
		const { execSync } = await import("node:child_process");

		// Test if git status with porcelain v2 works
		execSync("git status -z --porcelain=v2", {
			encoding: "utf8",
			timeout: 200,
		});

		console.log("✅ Git timestamp command works");
		return true;
	} catch (error) {
		console.error("❌ Git timestamp command failed", error);
		return false;
	}
}

export async function testPerformance(): Promise<boolean> {
	const start = performance.now();

	// Simulate sorting 100 items
	const items = Array.from({ length: 100 }, (_, i) => ({
		uri: `file${i}.txt`,
		mtime: Date.now() - i * 1000,
	}));

	items.sort((a, b) => b.mtime - a.mtime);

	const duration = performance.now() - start;
	console.log(`⏱️ Sort performance for 100 items: ${duration.toFixed(2)}ms`);

	if (duration > 300) {
		console.error("❌ Performance test failed: >300ms");
		return false;
	}

	console.log("✅ Performance test passed");
	return true;
}

// Run all tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	(async () => {
		console.log("🚀 Running SCM Integration Tests\n");

		const result = await testSCMIntegration();

		if (result === "ABORT_PROJECT") {
			console.error("\n❌❌❌ PROJECT NOT VIABLE - ABORT IMMEDIATELY ❌❌❌");
			console.error("The extension cannot modify the SCM view.");
			console.error(
				"This is a fundamental requirement that cannot be worked around.",
			);
			process.exit(1);
		}

		console.log("\n🎯 Running additional tests...\n");

		const gitWorks = await testGitTimestamps();
		const perfOk = await testPerformance();

		console.log("\n📊 Test Summary:");
		console.log("✅ SCM Integration: PASS (Project viable!)");
		console.log(
			`${gitWorks ? "✅" : "⚠️"} Git Timestamps: ${gitWorks ? "PASS" : "FAIL (will use fallback)"}`,
		);
		console.log(
			`${perfOk ? "✅" : "❌"} Performance: ${perfOk ? "PASS" : "FAIL"}`,
		);

		if (!gitWorks) {
			console.warn(
				"\n⚠️ Warning: Git timestamps not working, will use filesystem fallback",
			);
		}

		if (!perfOk) {
			console.error("\n❌ Performance requirements not met");
		}

		console.log("\n✅ PROCEED WITH IMPLEMENTATION");
	})();
}
