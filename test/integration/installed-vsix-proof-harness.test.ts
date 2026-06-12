import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentStatusProofTreeSnapshot,
	collectLauncherAttributedTaskIdHits,
	collectTaskIdPresence,
	expandedDefaultLaneRegistryPaths,
	findSpecBoundaryViolations,
	parseTaskIdListEnv,
} from "./installed-vsix-proof-shared.js";
import {
	buildSentinelFixtureRegistry,
	parseInstalledProofArgs,
	phaseManifestPath,
	readRegistryTaskIdSplitSafe,
	readRegistryTaskIdsSafe,
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
			phase: "both",
			vsixPath: "x.vsix",
			expectedSha256: "abc123",
			expectedIdentityKind: "temporary-proof-artifact",
		});
	});

	test("runs both proof phases by default and accepts targeted phases", () => {
		expect(parseInstalledProofArgs([]).phase).toBe("both");
		expect(
			parseInstalledProofArgs(["--phase", "quarantine-default"]).phase,
		).toBe("quarantine-default");
		expect(parseInstalledProofArgs(["--phase", "legacy-fixture"]).phase).toBe(
			"legacy-fixture",
		);
		expect(() => parseInstalledProofArgs(["--phase", "everything"])).toThrow(
			/quarantine-default, legacy-fixture, or both/,
		);
	});

	test("derives per-phase manifest paths from the base manifest path", () => {
		expect(phaseManifestPath("/logs/proof.json", "quarantine-default")).toBe(
			"/logs/proof-quarantine.json",
		);
		expect(phaseManifestPath("/logs/proof.json", "legacy-fixture")).toBe(
			"/logs/proof-legacy.json",
		);
		expect(phaseManifestPath("/logs/proof", "legacy-fixture")).toBe(
			"/logs/proof-legacy.json",
		);
	});

	test("sentinel fixture registry is version 2 with two distinct agent backends", () => {
		const { registry, taskIds } = buildSentinelFixtureRegistry(
			"2026-06-11T00:00:00.000Z",
		);
		expect(registry.version).toBe(2);
		expect(taskIds).toHaveLength(2);
		expect(Object.keys(registry.tasks)).toEqual(taskIds);
		const backends = new Set(
			Object.values(registry.tasks).map((task) => task["agent_backend"]),
		);
		expect(backends.size).toBe(2);
		for (const [taskId, task] of Object.entries(registry.tasks)) {
			expect(task["id"]).toBe(taskId);
			expect(task["status"]).toBe("running");
			expect(task["started_at"]).toBe("2026-06-11T00:00:00.000Z");
		}
	});

	test("reads registry task ids safely from real files and tolerates absence", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-proof-harness-"));
		const registryPath = path.join(tempDir, "tasks.json");
		writeFileSync(
			registryPath,
			JSON.stringify({ version: 2, tasks: { "id-a": {}, "id-b": {} } }),
		);
		expect(readRegistryTaskIdsSafe(registryPath)).toEqual(["id-a", "id-b"]);
		expect(readRegistryTaskIdsSafe(path.join(tempDir, "missing.json"))).toEqual(
			[],
		);
		writeFileSync(registryPath, "not-json");
		expect(readRegistryTaskIdsSafe(registryPath)).toEqual([]);
	});

	test("parses task id list env values and rejects malformed payloads", () => {
		expect(parseTaskIdListEnv(undefined)).toEqual([]);
		expect(parseTaskIdListEnv("")).toEqual([]);
		expect(parseTaskIdListEnv('["a", " b ", ""]')).toEqual(["a", "b"]);
		expect(() => parseTaskIdListEnv('{"a": 1}')).toThrow(/JSON array/);
		expect(() => parseTaskIdListEnv("[1]")).toThrow(/JSON array/);
	});

	test("splits registry ids into LaneRef-backed vs stale by project_ref.id", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-proof-harness-"));
		const registryPath = path.join(tempDir, "tasks.json");
		writeFileSync(
			registryPath,
			JSON.stringify({
				version: 2,
				tasks: {
					"lane-a": { project_ref: { id: "command-central" } },
					"stale-b": {},
					"stale-c": { project_ref: { id: "  " } },
				},
			}),
		);
		expect(readRegistryTaskIdSplitSafe(registryPath)).toEqual({
			laneBacked: ["lane-a"],
			stale: ["stale-b", "stale-c"],
		});
		expect(
			readRegistryTaskIdSplitSafe(path.join(tempDir, "missing.json")),
		).toEqual({ laneBacked: [], stale: [] });
	});

	test("expands the zero-config default lane registry paths against a home dir", () => {
		expect(expandedDefaultLaneRegistryPaths("/Users/proof")).toEqual([
			"/Users/proof/.config/openclaw/lanes.json",
			"/Users/proof/.config/ghostty-launcher/tasks.json",
		]);
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

	test("flags forbidden task ids only when they surface as launcher data", () => {
		const snapshot: AgentStatusProofTreeSnapshot = {
			rootChildrenCount: 2,
			taskCount: 2,
			roots: [
				{
					label: "Run Attempts · 2",
					nodeKind: "codexRuns",
					children: [
						{
							label: "cc-real-task — running",
							nodeKind: "codexRun",
							ownerFields: {
								taskId: "cc-real-task",
								source_owner: "launcher",
							},
						},
						{
							label: "cc-openclaw-task — running",
							nodeKind: "codexRun",
							ownerFields: {
								taskId: "cc-openclaw-task",
								source_owner: "openclaw",
								source_authority: "openclaw",
							},
						},
					],
				},
			],
			selected: { requiredLabels: {} },
		};

		const hits = collectLauncherAttributedTaskIdHits(snapshot, [
			"cc-real-task",
			"cc-openclaw-task",
		]);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.taskId).toBe("cc-real-task");
		expect(hits[0]?.reason).toBe("source_owner=launcher");

		const presence = collectTaskIdPresence(snapshot, [
			"cc-real-task",
			"cc-openclaw-task",
			"cc-absent-task",
		]);
		expect(presence).toEqual({
			"cc-real-task": true,
			"cc-openclaw-task": true,
			"cc-absent-task": false,
		});
	});

	test("flags launcher task nodes by node kind even without owner fields", () => {
		const snapshot: AgentStatusProofTreeSnapshot = {
			rootChildrenCount: 1,
			taskCount: 1,
			roots: [
				{
					label: "stale-launcher-lane",
					nodeKind: "task",
				},
			],
			selected: { requiredLabels: {} },
		};
		const hits = collectLauncherAttributedTaskIdHits(snapshot, [
			"stale-launcher-lane",
		]);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.reason).toBe("nodeKind=task");
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
			"src/services/integration-test-api.ts",
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
