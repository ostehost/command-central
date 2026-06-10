/**
 * agent-task-classification — focused tests for the classification module
 * extracted from agent-status-tree-provider.ts.
 *
 * classifyCompletionRouting and classifyLifecycleConflict keep their existing
 * coverage in agent-status-tree-provider-pure-helpers.test.ts (via the
 * provider's re-exports). This file covers the surface classifier and the
 * host/display helpers, which previously had no direct tests.
 *
 * No provider is instantiated and the module under test never imports vscode,
 * so no module mocks are needed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	__setCurrentMachineHostOverrideForTests,
	classifyTaskSurface,
	getTaskDisplayProjectName,
	getTaskExecutionHostLabel,
	isRemoteNodeTaskForCurrentHost,
} from "../../src/providers/agent-task-classification.js";
import { createMockTask } from "./_helpers/agent-status-tree-provider-test-base.js";

afterEach(() => {
	__setCurrentMachineHostOverrideForTests(null);
});

describe("classifyTaskSurface", () => {
	test("tmux task with launcher bundle → launcher-bundle, no short tag", () => {
		const task = createMockTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: "com.ghostty.launcher.task1",
		});
		const surface = classifyTaskSurface(task);
		expect(surface.kind).toBe("launcher-bundle");
		expect(surface.shortTag).toBeNull();
		expect(surface.tooltipLine).toContain("launcher Ghostty bundle");
	});

	test("tmux task without bundle → tmux-fresh-attach", () => {
		const task = createMockTask({
			terminal_backend: "tmux",
			bundle_path: "(tmux-mode)",
		});
		const surface = classifyTaskSurface(task);
		expect(surface.kind).toBe("tmux-fresh-attach");
		expect(surface.shortTag).toBe("tmux · fresh attach");
	});

	test("'(test-mode)' bundle_path sentinel does not count as a bundle", () => {
		const task = createMockTask({
			terminal_backend: "tmux",
			bundle_path: "(test-mode)",
		});
		expect(classifyTaskSurface(task).kind).toBe("tmux-fresh-attach");
	});

	test("remote-node tmux task with bundle → node-launcher-bundle", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const task = createMockTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: "com.ghostty.launcher.task1",
			exec_host: "Node Mac",
		});
		const surface = classifyTaskSurface(task);
		expect(surface.kind).toBe("node-launcher-bundle");
		expect(surface.shortTag).toBe("node · visible");
		expect(surface.tooltipLine).toContain("Node Mac");
	});

	test("remote-node tmux task without bundle → node-tmux-fresh-attach", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const task = createMockTask({
			terminal_backend: "tmux",
			bundle_path: "(tmux-mode)",
			exec_host: "Node Mac",
		});
		const surface = classifyTaskSurface(task);
		expect(surface.kind).toBe("node-tmux-fresh-attach");
		expect(surface.shortTag).toBe("node · tmux");
		expect(surface.tooltipLine).toContain("no hub-local terminal");
	});

	test("tmux task on the current host stays a local surface", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const task = createMockTask({
			terminal_backend: "tmux",
			ghostty_bundle_id: "com.ghostty.launcher.task1",
			exec_host: "hub mac.local",
		});
		expect(classifyTaskSurface(task).kind).toBe("launcher-bundle");
	});

	test("persist backend → persist (headless)", () => {
		const task = createMockTask({ terminal_backend: "persist" });
		const surface = classifyTaskSurface(task);
		expect(surface.kind).toBe("persist");
		expect(surface.shortTag).toBe("persist");
	});

	test("applescript backend → applescript", () => {
		const task = createMockTask({ terminal_backend: "applescript" });
		const surface = classifyTaskSurface(task);
		expect(surface.kind).toBe("applescript");
		expect(surface.shortTag).toBe("applescript");
	});

	test("no backend but real bundle path → launcher-bundle", () => {
		const task = createMockTask({
			bundle_path: "/Applications/Projects/My App.app",
		});
		const surface = classifyTaskSurface(task);
		expect(surface.kind).toBe("launcher-bundle");
		expect(surface.shortTag).toBeNull();
	});

	test("no backend and no bundle → unknown with 'surface?' tag", () => {
		const task = createMockTask({ bundle_path: "" });
		const surface = classifyTaskSurface(task);
		expect(surface.kind).toBe("unknown");
		expect(surface.shortTag).toBe("surface?");
		expect(surface.tooltipLine).toContain("no authoritative terminal surface");
	});
});

describe("getTaskExecutionHostLabel", () => {
	test("prefers exec_host over exec_node", () => {
		const task = createMockTask({
			exec_host: "Node Mac",
			exec_node: "node-1",
		});
		expect(getTaskExecutionHostLabel(task)).toBe("Node Mac");
	});

	test("falls back to exec_node when exec_host is blank", () => {
		const task = createMockTask({ exec_host: "  ", exec_node: "node-1" });
		expect(getTaskExecutionHostLabel(task)).toBe("node-1");
	});

	test("returns null when no host metadata is recorded", () => {
		expect(getTaskExecutionHostLabel(createMockTask())).toBeNull();
	});
});

describe("isRemoteNodeTaskForCurrentHost", () => {
	test("task on a different host is remote", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const task = createMockTask({ exec_host: "Node Mac" });
		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(true);
	});

	test("host comparison normalizes case and .local suffix", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const task = createMockTask({ exec_host: "HUB MAC.local" });
		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(false);
	});

	test("task without node metadata is never remote", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		expect(isRemoteNodeTaskForCurrentHost(createMockTask())).toBe(false);
	});

	test("exec_mode=node without exec_host degrades to local", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const task = createMockTask({ exec_mode: "node" });
		expect(isRemoteNodeTaskForCurrentHost(task)).toBe(false);
	});
});

describe("getTaskDisplayProjectName", () => {
	test("prefers visible_project_name", () => {
		const task = createMockTask({
			visible_project_name: "Pretty Name",
			project_name: "my-app",
		});
		expect(getTaskDisplayProjectName(task)).toBe("Pretty Name");
	});

	test("falls back to project_name", () => {
		const task = createMockTask({
			visible_project_name: null,
			project_name: "my-app",
		});
		expect(getTaskDisplayProjectName(task)).toBe("my-app");
	});

	test("falls back to project_dir basename when names are blank", () => {
		const task = createMockTask({
			visible_project_name: "  ",
			project_name: "",
			project_dir: "/Users/test/projects/my-app",
		});
		expect(getTaskDisplayProjectName(task)).toBe("my-app");
	});
});
