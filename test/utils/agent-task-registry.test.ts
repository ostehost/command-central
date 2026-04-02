import { describe, expect, test } from "bun:test";
import {
	clearCompletedAgentEntries,
	countClearableAgentEntries,
	parseTaskRegistry,
	removeTaskFromRegistryMap,
	serializeTaskRegistry,
} from "../../src/utils/agent-task-registry.js";

describe("agent task registry utils", () => {
	test("parseTaskRegistry defaults invalid versions to 2", () => {
		const parsed = parseTaskRegistry(
			JSON.stringify({
				version: 99,
				tasks: {
					one: { id: "one", status: "completed" },
				},
			}),
		);

		expect(parsed.version).toBe(2);
		expect(parsed.tasks["one"]).toBeDefined();
	});

	test("removeTaskFromRegistryMap falls back to nested id matching", () => {
		const tasks: Record<string, unknown> = {
			"launcher-key": { id: "task-1", status: "failed" },
			other: { id: "task-2", status: "running" },
		};

		expect(removeTaskFromRegistryMap(tasks, "task-1")).toBe(true);
		expect(tasks["launcher-key"]).toBeUndefined();
		expect(tasks["other"]).toBeDefined();
	});

	test("count and clear helpers ignore contract_failure entries", () => {
		const tasks: Record<string, unknown> = {
			completed: { id: "completed", status: "completed" },
			dirty: { id: "dirty", status: "completed_dirty" },
			stale: { id: "stale", status: "completed_stale" },
			failed: { id: "failed", status: "failed" },
			stopped: { id: "stopped", status: "stopped" },
			killed: { id: "killed", status: "killed" },
			contract: { id: "contract", status: "contract_failure" },
			running: { id: "running", status: "running" },
		};

		expect(countClearableAgentEntries(tasks)).toBe(6);
		expect(clearCompletedAgentEntries(tasks)).toBe(6);
		expect(Object.keys(tasks)).toEqual(["contract", "running"]);
	});

	test("serializeTaskRegistry emits trailing newline", () => {
		const serialized = serializeTaskRegistry({
			version: 2,
			tasks: {
				one: { id: "one", status: "completed" },
			},
		});

		expect(serialized.endsWith("\n")).toBe(true);
		expect(JSON.parse(serialized)).toEqual({
			version: 2,
			tasks: {
				one: { id: "one", status: "completed" },
			},
		});
	});
});
