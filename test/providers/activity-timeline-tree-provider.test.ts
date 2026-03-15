/**
 * ActivityTimelineTreeProvider Tests
 *
 * Tests tree structure, time grouping, rendering, icons, labels,
 * and empty state behavior.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ActivityCollector } from "../../src/services/activity-collector.js";
import type { ActivityEvent } from "../../src/services/activity-event-types.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// ── Mock collector ───────────────────────────────────────────────────

function createMockCollector(events: ActivityEvent[] = []) {
	return {
		collectEvents: mock(async () => events),
		parseGitOutput: mock(() => []),
	} as unknown as ActivityCollector & {
		collectEvents: ReturnType<typeof mock>;
	};
}

// ── Test event factories ─────────────────────────────────────────────

function createCommitEvent(
	overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
	return {
		id: "a".repeat(40),
		timestamp: new Date("2026-03-15T10:00:00Z"),
		agent: { name: "Claude Opus 4" },
		action: {
			type: "commit",
			sha: "a".repeat(40),
			message: "feat: add timeline",
			filesChanged: 3,
			insertions: 50,
			deletions: 10,
		},
		project: { name: "my-project", dir: "/mock/my-project" },
		...overrides,
	};
}

function createTaskCompletedEvent(
	overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
	return {
		id: "task-42",
		timestamp: new Date("2026-03-15T09:00:00Z"),
		agent: { name: "Claude", role: "developer" },
		action: {
			type: "task-completed",
			taskId: "task-42",
			exitCode: 0,
			duration: "23m",
		},
		project: { name: "my-project", dir: "/mock/my-project" },
		...overrides,
	};
}

function createTaskFailedEvent(
	overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
	return {
		id: "task-7",
		timestamp: new Date("2026-03-14T15:00:00Z"),
		agent: { name: "Claude", role: "reviewer" },
		action: {
			type: "task-failed",
			taskId: "task-7",
			exitCode: 1,
			error: "Test assertion failed",
		},
		project: { name: "my-project", dir: "/mock/my-project" },
		...overrides,
	};
}

function createTaskStartedEvent(
	overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
	return {
		id: "task-15",
		timestamp: new Date("2026-03-15T11:00:00Z"),
		agent: { name: "Claude", role: "planner" },
		action: {
			type: "task-started",
			taskId: "task-15",
			prompt: "Implement feature X",
		},
		project: { name: "my-project", dir: "/mock/my-project" },
		...overrides,
	};
}

describe("ActivityTimelineTreeProvider", () => {
	let ActivityTimelineTreeProvider: typeof import("../../src/providers/activity-timeline-tree-provider.js").ActivityTimelineTreeProvider;

	beforeEach(async () => {
		mock.restore();
		setupVSCodeMock();

		const mod = await import(
			"../../src/providers/activity-timeline-tree-provider.js"
		);
		ActivityTimelineTreeProvider = mod.ActivityTimelineTreeProvider;
	});

	// ── getChildren — root level ─────────────────────────────────────

	describe("getChildren at root level", () => {
		test("returns TimelineGroups at root when events exist", async () => {
			const events = [createCommitEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const children = provider.getChildren();

			expect(children.length).toBeGreaterThan(0);
			expect(children[0]?.type).toBe("timelineGroup");
		});

		test("returns empty array when no events", async () => {
			const collector = createMockCollector([]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const children = provider.getChildren();

			expect(children).toEqual([]);
		});

		test("groups events by time period", async () => {
			const now = new Date();
			const recentEvent = createCommitEvent({
				id: "recent",
				timestamp: new Date(now.getTime() - 30 * 60 * 1000), // 30 min ago
			});
			const olderEvent = createCommitEvent({
				id: "older",
				timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
			});

			const collector = createMockCollector([recentEvent, olderEvent]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const children = provider.getChildren();

			// Should have at least 2 groups (different periods)
			expect(children.length).toBeGreaterThanOrEqual(2);
			for (const child of children) {
				expect(child.type).toBe("timelineGroup");
			}
		});

		test("groups are ordered by period (lastHour, today, yesterday, ...)", async () => {
			const now = new Date();
			const hourAgo = createCommitEvent({
				id: "recent",
				timestamp: new Date(now.getTime() - 20 * 60 * 1000),
			});
			const twoDaysAgo = createCommitEvent({
				id: "old",
				timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
			});

			const collector = createMockCollector([twoDaysAgo, hourAgo]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const children = provider.getChildren();

			expect(children.length).toBe(2);
			// First group should be the more recent period
			const first = children[0];
			if (first?.type === "timelineGroup") {
				expect(["Last Hour", "Today"]).toContain(first.group.label);
			}
		});
	});

	// ── getChildren — event level ────────────────────────────────────

	describe("getChildren under a group", () => {
		test("returns events under a TimelineGroup", async () => {
			const events = [createCommitEvent(), createTaskCompletedEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();

			// Find a group with events
			let totalEvents = 0;
			for (const group of groups) {
				const groupChildren = provider.getChildren(group);
				totalEvents += groupChildren.length;
				for (const child of groupChildren) {
					expect(child.type).toBe("activityEvent");
				}
			}
			expect(totalEvents).toBe(2);
		});

		test("returns empty for an event node (leaf)", async () => {
			const events = [createCommitEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const groupChildren = provider.getChildren(firstGroup);
			const firstChild = groupChildren[0];
			expect(firstChild).toBeDefined();
			if (!firstChild) return;
			const leafChildren = provider.getChildren(firstChild);

			expect(leafChildren).toEqual([]);
		});
	});

	// ── getTreeItem rendering ────────────────────────────────────────

	describe("getTreeItem rendering", () => {
		test("renders commit event with correct icon and label", async () => {
			const events = [createCommitEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const eventNodes = provider.getChildren(firstGroup);
			const firstNode = eventNodes[0];
			expect(firstNode).toBeDefined();
			if (!firstNode) return;
			const item = provider.getTreeItem(firstNode);

			expect(item.label).toBe("feat: add timeline");
			expect((item.iconPath as { id: string }).id).toBe("git-commit");
			expect(item.description).toContain("Claude Opus 4");
			expect(item.description).toContain("3 files");
			expect(item.contextValue).toBe("activityEvent.commit");
		});

		test("renders task-completed event correctly", async () => {
			const events = [createTaskCompletedEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const eventNodes = provider.getChildren(firstGroup);
			const firstNode = eventNodes[0];
			expect(firstNode).toBeDefined();
			if (!firstNode) return;
			const item = provider.getTreeItem(firstNode);

			expect(item.label).toBe("task-42 completed");
			expect((item.iconPath as { id: string }).id).toBe("check");
			expect(item.description).toContain("developer");
			expect(item.description).toContain("my-project");
			expect(item.contextValue).toBe("activityEvent.task-completed");
		});

		test("renders task-failed event correctly", async () => {
			const events = [createTaskFailedEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const eventNodes = provider.getChildren(firstGroup);
			const firstNode = eventNodes[0];
			expect(firstNode).toBeDefined();
			if (!firstNode) return;
			const item = provider.getTreeItem(firstNode);

			expect(item.label).toBe("task-7 failed");
			expect((item.iconPath as { id: string }).id).toBe("error");
			expect(item.description).toContain("reviewer");
			expect(item.description).toContain("exit 1");
			expect(item.contextValue).toBe("activityEvent.task-failed");
		});

		test("renders task-started event correctly", async () => {
			const events = [createTaskStartedEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const eventNodes = provider.getChildren(firstGroup);
			const firstNode = eventNodes[0];
			expect(firstNode).toBeDefined();
			if (!firstNode) return;
			const item = provider.getTreeItem(firstNode);

			expect(item.label).toBe("task-15 started");
			expect((item.iconPath as { id: string }).id).toBe("play");
			expect(item.description).toContain("planner");
			expect(item.contextValue).toBe("activityEvent.task-started");
		});

		test("renders group item with event count", async () => {
			const events = [
				createCommitEvent({ id: "1" }),
				createTaskCompletedEvent({ id: "2" }),
			];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const groupItem = provider.getTreeItem(firstGroup);

			expect(groupItem.label).toContain("2 events");
			expect((groupItem.iconPath as { id: string }).id).toBe("calendar");
			expect(groupItem.collapsibleState).toBe(2); // Expanded
		});

		test("renders singular 'event' for single event group", async () => {
			const events = [createCommitEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const groupItem = provider.getTreeItem(firstGroup);

			expect(groupItem.label).toContain("1 event)");
			expect(groupItem.label).not.toContain("1 events");
		});

		test("commit event shows singular 'file' for 1 file", async () => {
			const singleFileEvent = createCommitEvent({
				action: {
					type: "commit",
					sha: "a".repeat(40),
					message: "fix: one file",
					filesChanged: 1,
					insertions: 5,
					deletions: 2,
				},
			});
			const collector = createMockCollector([singleFileEvent]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const eventNodes = provider.getChildren(firstGroup);
			const firstNode = eventNodes[0];
			expect(firstNode).toBeDefined();
			if (!firstNode) return;
			const item = provider.getTreeItem(firstNode);

			expect(item.description).toContain("1 file");
			expect(item.description).not.toContain("1 files");
		});

		test("event without role shows 'agent' as fallback", async () => {
			const noRoleEvent = createTaskCompletedEvent({
				agent: { name: "Claude" }, // no role
			});
			const collector = createMockCollector([noRoleEvent]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const eventNodes = provider.getChildren(firstGroup);
			const firstNode = eventNodes[0];
			expect(firstNode).toBeDefined();
			if (!firstNode) return;
			const item = provider.getTreeItem(firstNode);

			expect(item.description).toContain("agent");
		});
	});

	// ── getParent ────────────────────────────────────────────────────

	describe("getParent", () => {
		test("returns group for an event node", async () => {
			const events = [createCommitEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;
			const eventNodes = provider.getChildren(firstGroup);
			const firstNode = eventNodes[0];
			expect(firstNode).toBeDefined();
			if (!firstNode) return;

			const parent = provider.getParent(firstNode);
			expect(parent?.type).toBe("timelineGroup");
		});

		test("returns undefined for group nodes", async () => {
			const events = [createCommitEvent()];
			const collector = createMockCollector(events);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const groups = provider.getChildren();
			const firstGroup = groups[0];
			expect(firstGroup).toBeDefined();
			if (!firstGroup) return;

			const parent = provider.getParent(firstGroup);
			expect(parent).toBeUndefined();
		});
	});

	// ── Empty state ──────────────────────────────────────────────────

	describe("empty state", () => {
		test("returns empty array before refresh is called", () => {
			const collector = createMockCollector([]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			const children = provider.getChildren();
			expect(children).toEqual([]);
		});

		test("returns empty array after refresh with no events", async () => {
			const collector = createMockCollector([]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			await provider.refresh();
			const children = provider.getChildren();
			expect(children).toEqual([]);
		});
	});

	// ── refresh ──────────────────────────────────────────────────────

	describe("refresh", () => {
		test("calls collector.collectEvents with correct args", async () => {
			const collector = createMockCollector([]);
			const provider = new ActivityTimelineTreeProvider(
				collector,
				["/ws/a", "/ws/b"],
				14,
			);

			await provider.refresh();

			expect(collector.collectEvents).toHaveBeenCalledWith(
				["/ws/a", "/ws/b"],
				14,
			);
		});

		test("updates tree data after refresh", async () => {
			const collector = createMockCollector([]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			// Initially empty
			expect(provider.getChildren()).toEqual([]);

			// Update mock to return events — need to cast to reassign
			const mutableCollector = collector as unknown as {
				collectEvents: (...args: unknown[]) => Promise<ActivityEvent[]>;
			};
			mutableCollector.collectEvents = mock(async () => [createCommitEvent()]);
			await provider.refresh();

			expect(provider.getChildren().length).toBe(1);
		});
	});

	// ── updateWorkspaceFolders ────────────────────────────────────────

	describe("updateWorkspaceFolders", () => {
		test("updates workspace folders for subsequent refreshes", async () => {
			const collector = createMockCollector([]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/old/workspace",
			]);

			provider.updateWorkspaceFolders(["/new/workspace"]);
			await provider.refresh();

			expect(collector.collectEvents).toHaveBeenCalledWith(
				["/new/workspace"],
				7,
			);
		});
	});

	// ── dispose ──────────────────────────────────────────────────────

	describe("dispose", () => {
		test("does not throw", () => {
			const collector = createMockCollector([]);
			const provider = new ActivityTimelineTreeProvider(collector, [
				"/mock/workspace",
			]);

			expect(() => provider.dispose()).not.toThrow();
		});
	});
});
