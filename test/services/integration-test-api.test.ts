import { describe, expect, test } from "bun:test";
import type { AgentStatusTreeProvider } from "../../src/providers/agent-status-tree-provider.js";
import { getLauncherRegistrySnapshotForProvider } from "../../src/services/integration-test-api.js";
import { DEFAULT_LANE_REGISTRY_FILES } from "../../src/utils/tasks-file-resolver.js";

function stubProvider(params: {
	filePaths: string[];
	launcherTaskIds: string[];
}): AgentStatusTreeProvider {
	return {
		filePaths: params.filePaths,
		getLauncherTasks: () => params.launcherTaskIds.map((id) => ({ id })),
	} as unknown as AgentStatusTreeProvider;
}

describe("getLauncherRegistrySnapshotForProvider", () => {
	test("returns an empty quarantine-shaped snapshot without a provider", () => {
		expect(getLauncherRegistrySnapshotForProvider(undefined)).toEqual({
			resolvedFilePaths: [],
			launcherTaskCount: 0,
			launcherTaskIds: [],
		});
	});

	test("reports resolved registry paths and launcher-only task ids", () => {
		const provider = stubProvider({
			filePaths: ["/tmp/fixture/tasks.json"],
			launcherTaskIds: ["installed-proof-legacy-alpha", "task-b"],
		});
		expect(getLauncherRegistrySnapshotForProvider(provider)).toEqual({
			resolvedFilePaths: ["/tmp/fixture/tasks.json"],
			launcherTaskCount: 2,
			launcherTaskIds: ["installed-proof-legacy-alpha", "task-b"],
		});
	});

	test("reflects an explicit lane-registry opt-out: no resolved paths, no tasks", () => {
		const provider = stubProvider({ filePaths: [], launcherTaskIds: [] });
		const snapshot = getLauncherRegistrySnapshotForProvider(provider);
		expect(snapshot.resolvedFilePaths).toEqual([]);
		expect(snapshot.launcherTaskCount).toBe(0);
	});

	test("mirrors the zero-config default: lane registries resolved in precedence order, LaneRef-backed ids only", () => {
		const provider = stubProvider({
			filePaths: [...DEFAULT_LANE_REGISTRY_FILES],
			launcherTaskIds: ["cc-lane-backed-task"],
		});
		const snapshot = getLauncherRegistrySnapshotForProvider(provider);
		expect(snapshot.resolvedFilePaths).toEqual([
			...DEFAULT_LANE_REGISTRY_FILES,
		]);
		expect(snapshot.resolvedFilePaths[0]).toBe("~/.config/openclaw/lanes.json");
		expect(snapshot.launcherTaskCount).toBe(1);
		expect(snapshot.launcherTaskIds).toEqual(["cc-lane-backed-task"]);
	});
});
