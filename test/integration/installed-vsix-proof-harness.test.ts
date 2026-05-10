import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	type AgentStatusProofTreeSnapshot,
	findSpecBoundaryViolations,
} from "./installed-vsix-proof-shared.js";
import {
	parseInstalledProofArgs,
	resolveInstalledProofVsixPath,
} from "./runInstalledVsixAgentStatusProof.js";

const repoRoot = path.resolve(import.meta.dir, "../..");

describe("installed VSIX Agent Status proof harness", () => {
	test("resolves VSIX path from CLI, environment, then package version default", () => {
		expect(
			resolveInstalledProofVsixPath({
				cliVsixPath: "cli.vsix",
				envVsixPath: "/env.vsix",
				repoRoot,
				packageVersion: "0.6.0-rc.22",
			}),
		).toBe(path.join(repoRoot, "cli.vsix"));

		expect(
			resolveInstalledProofVsixPath({
				envVsixPath: "/env.vsix",
				repoRoot,
				packageVersion: "0.6.0-rc.22",
			}),
		).toBe("/env.vsix");

		expect(
			resolveInstalledProofVsixPath({
				repoRoot,
				packageVersion: "0.6.0-rc.22",
			}),
		).toBe(path.join(repoRoot, "releases", "command-central-0.6.0-rc.22.vsix"));
	});

	test("parses passive and live modes without hard-coding an rc version", () => {
		expect(parseInstalledProofArgs(["--passive"]).mode).toBe("passive");
		expect(
			parseInstalledProofArgs([
				"--live",
				"--vsix",
				"x.vsix",
				"--expected-sha",
				"abc123",
				"--identity-kind",
				"temporary-proof-artifact",
			]),
		).toEqual({
			mode: "live",
			vsixPath: "x.vsix",
			expectedSha256: "abc123",
			expectedIdentityKind: "temporary-proof-artifact",
		});
	});

	test("rejects invalid expected VSIX identity kinds", () => {
		expect(() =>
			parseInstalledProofArgs([
				"--expected-sha",
				"abc123",
				"--identity-kind",
				"rc22",
			]),
		).toThrow(/published-prerelease or temporary-proof-artifact/);
	});

	test("manifest identity fields distinguish expected SHA from published release identity", async () => {
		const source = await Bun.file(
			path.join(repoRoot, "test/integration/installed-vsix-proof-suite.ts"),
		).text();

		expect(source).toContain("expected_vsix_sha256");
		expect(source).toContain("vsix_matches_expected_sha");
		expect(source).toContain("expected_vsix_identity_kind");
		expect(source).toContain("published_release_match");
		expect(source).not.toContain("vsix_matches_published_release");
		expect(source).toContain('expectedIdentityKind === "published-prerelease"');
	});

	test("rejects scheduler-owned commands under the Symphony surface", () => {
		const snapshot: AgentStatusProofTreeSnapshot = {
			rootChildrenCount: 1,
			taskCount: 1,
			roots: [
				{
					label: "Symphony",
					nodeKind: "symphony",
					children: [
						{
							label: "Run Attempts · 1",
							nodeKind: "codexRuns",
							children: [
								{
									label: "Run A",
									nodeKind: "codexRun",
									command: {
										command: "commandCentral.dispatchRetry",
										title: "Dispatch Retry",
									},
								},
							],
						},
					],
				},
			],
			selected: { requiredLabels: {} },
		};

		expect(findSpecBoundaryViolations(snapshot)).toHaveLength(1);
	});

	test("keeps COMMAND_CENTRAL_TEST_MODE limited to inspection API exposure", async () => {
		const sourceFiles = [
			"src/extension.ts",
			"src/providers/agent-status-tree-provider.ts",
			"src/services/codex-run-observer-service.ts",
			"src/commands/workflow-run-actions.ts",
		];
		const combined = (
			await Promise.all(
				sourceFiles.map((filePath) =>
					Bun.file(path.join(repoRoot, filePath)).text(),
				),
			)
		).join("\n");

		expect(combined).not.toMatch(
			/COMMAND_CENTRAL_TEST_MODE[\s\S]{0,120}watchers?/i,
		);
		expect(combined).not.toMatch(/COMMAND_CENTRAL_TEST_MODE[\s\S]{0,120}fake/i);
		expect(combined).not.toMatch(
			/COMMAND_CENTRAL_TEST_MODE[\s\S]{0,120}timing/i,
		);
		expect(combined).not.toMatch(
			/COMMAND_CENTRAL_TEST_MODE[\s\S]{0,120}skip activation/i,
		);
		expect(combined).not.toMatch(
			/COMMAND_CENTRAL_TEST_MODE[\s\S]{0,120}suppress/i,
		);
		expect(combined).toContain("getAgentStatusTreeSnapshot");
	});
});
