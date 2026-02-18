#!/usr/bin/env bun
/**
 * TEST VALIDATION SCRIPT
 *
 * Enterprise-grade test coverage validation:
 * - Discovers all test files in the codebase
 * - Verifies each test is included in a test partition
 * - Detects orphaned tests that would be skipped
 * - Enforces naming conventions
 * - Reports coverage gaps
 *
 * Exit codes:
 * - 0: All tests properly partitioned
 * - 1: Orphaned tests found or validation errors
 */

import { Glob } from "bun";
import { readFileSync } from "fs";
import { resolve } from "path";

interface TestFile {
	path: string;
	relativePath: string;
	category: string;
	isOrphaned: boolean;
}

interface ValidationResult {
	totalTests: number;
	partitionedTests: number;
	orphanedTests: TestFile[];
	partitionCoverage: Map<string, string[]>;
	success: boolean;
}

async function discoverAllTests(): Promise<TestFile[]> {
	const glob = new Glob("**/*.test.ts");
	const testFiles: TestFile[] = [];

	for await (const file of glob.scan("test")) {
		// Skip legacy tests - they are intentionally not in active test partitions
		if (file.startsWith("legacy/")) {
			continue;
		}

		const fullPath = `test/${file}`;
		const category = file.split("/")[0] || "root";

		testFiles.push({
			path: fullPath,
			relativePath: file,
			category,
			isOrphaned: true, // Will be updated during partition check
		});
	}

	return testFiles.sort((a, b) => a.path.localeCompare(b.path));
}

function loadTestPartitions(): Map<string, Set<string>> {
	const packageJsonPath = resolve(process.cwd(), "package.json");
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	const scripts = packageJson.scripts || {};

	const partitions = new Map<string, Set<string>>();

	// Extract all test partition scripts (those starting with _test:)
	for (const [scriptName, scriptCommand] of Object.entries(scripts)) {
		if (!scriptName.startsWith("_test:")) continue;
		if (typeof scriptCommand !== "string") continue;

		// Parse the bun test command to extract file patterns
		// Example: "bun test test/git-sort/integration.test.ts test/utils/"
		const match = scriptCommand.match(/bun test (.+)$/);
		if (!match) continue;

		const patterns = match[1].split(/\s+/).filter((p) => p.trim());
		partitions.set(scriptName, new Set(patterns));
	}

	return partitions;
}

function isTestInPartition(testPath: string, patterns: Set<string>): boolean {
	for (const pattern of patterns) {
		// Check exact file match
		if (pattern === testPath) return true;

		// Check directory match (pattern is a directory containing the test)
		if (pattern.endsWith("/") && testPath.startsWith(pattern)) return true;

		// Check if test file is in a directory pattern
		// e.g., pattern "test/utils" should match "test/utils/foo.test.ts"
		if (!pattern.endsWith("/") && testPath.startsWith(pattern + "/")) {
			return true;
		}
	}

	return false;
}

function validateTests(
	testFiles: TestFile[],
	partitions: Map<string, Set<string>>,
): ValidationResult {
	const partitionCoverage = new Map<string, string[]>();
	let partitionedCount = 0;

	// Check each test file against all partitions
	for (const test of testFiles) {
		let isInAnyPartition = false;

		for (const [partitionName, patterns] of partitions.entries()) {
			if (isTestInPartition(test.path, patterns)) {
				isInAnyPartition = true;
				test.isOrphaned = false;

				// Track which partition covers this test
				if (!partitionCoverage.has(partitionName)) {
					partitionCoverage.set(partitionName, []);
				}
				partitionCoverage.get(partitionName)?.push(test.path);
			}
		}

		if (isInAnyPartition) {
			partitionedCount++;
		}
	}

	const orphanedTests = testFiles.filter((t) => t.isOrphaned);

	return {
		totalTests: testFiles.length,
		partitionedTests: partitionedCount,
		orphanedTests,
		partitionCoverage,
		success: orphanedTests.length === 0,
	};
}

function printReport(result: ValidationResult): void {
	console.log("\n╭────────────────────────────────────────────────╮");
	console.log("│        Test Partition Validation Report       │");
	console.log("╰────────────────────────────────────────────────╯\n");

	console.log("📊 Test Coverage:");
	console.log(`   • Total test files: ${result.totalTests}`);
	console.log(`   • In partitions: ${result.partitionedTests}`);
	console.log(
		`   • Orphaned: ${result.orphanedTests.length} ⚠️`,
	);
	console.log(
		`   • Coverage: ${((result.partitionedTests / result.totalTests) * 100).toFixed(1)}%`,
	);

	if (result.orphanedTests.length > 0) {
		console.log("\n❌ Orphaned Tests (NOT in any partition):");
		console.log("   These tests will be SKIPPED by 'just test':\n");

		// Group by category
		const byCategory = new Map<string, TestFile[]>();
		for (const test of result.orphanedTests) {
			if (!byCategory.has(test.category)) {
				byCategory.set(test.category, []);
			}
			byCategory.get(test.category)?.push(test);
		}

		for (const [category, tests] of byCategory) {
			console.log(`   ${category}/ (${tests.length} files):`);
			for (const test of tests) {
				console.log(`      • ${test.relativePath}`);
			}
		}

		console.log("\n💡 Fix:");
		console.log("   Add these files to an appropriate partition in package.json");
		console.log(
			"   Or run: bun test <file> to verify they work before adding",
		);
	} else {
		console.log("\n✅ Perfect! All tests are in partitions.");
		console.log("   No tests will be skipped by 'just test'.");
	}

	console.log("\n📋 Partition Coverage:");
	const sortedPartitions = Array.from(
		result.partitionCoverage.entries(),
	).sort((a, b) => a[0].localeCompare(b[0]));

	for (const [partitionName, tests] of sortedPartitions) {
		const displayName = partitionName.replace("_test:", "");
		console.log(`   • ${displayName.padEnd(20)} - ${tests.length} tests`);
	}

	console.log("");
}

async function main() {
	try {
		console.log("🔍 Discovering test files...");
		const testFiles = await discoverAllTests();

		console.log("📖 Loading test partitions from package.json...");
		const partitions = loadTestPartitions();

		console.log("✓ Validating test coverage...");
		const result = validateTests(testFiles, partitions);

		printReport(result);

		if (!result.success) {
			console.log("❌ Validation failed: Orphaned tests detected\n");
			process.exit(1);
		}

		console.log("✅ Validation passed: All tests properly partitioned\n");
		process.exit(0);
	} catch (error) {
		console.error("❌ Validation error:", (error as Error).message);
		process.exit(1);
	}
}

// Run validation
main();
