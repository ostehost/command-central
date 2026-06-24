/**
 * Agent Events Tests
 *
 * Tests the AgentEvent interface and the EventEmitter-based lifecycle events
 * fired by AgentStatusTreeProvider (agent-started, agent-completed, agent-failed).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentEvent } from "../../src/events/agent-events.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";
import {
	type AgentTask,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	type ProviderHarness,
} from "../tree-view/_helpers/agent-status-tree-provider-test-base.js";

/** A task seed for the provider lifecycle tests — `id` drives the registry key. */
type AgentEventTaskInput = Partial<AgentTask> & { id: string };

beforeEach(() => {
	mock.restore();
	setupVSCodeMock();
});

describe("AgentEvent interface", () => {
	test("agent-started event has correct shape", () => {
		const event: AgentEvent = {
			type: "agent-started",
			taskId: "cc-task-1",
			timestamp: new Date(),
			projectDir: "/tmp/project",
		};

		expect(event.type).toBe("agent-started");
		expect(event.taskId).toBe("cc-task-1");
		expect(event.timestamp).toBeInstanceOf(Date);
		expect(event.projectDir).toBe("/tmp/project");
	});

	test("agent-completed event has correct shape", () => {
		const event: AgentEvent = {
			type: "agent-completed",
			taskId: "cc-task-2",
			timestamp: new Date(),
			projectDir: "/tmp/project",
			elapsed: "5m",
		};

		expect(event.type).toBe("agent-completed");
		expect(event.elapsed).toBe("5m");
	});

	test("agent-failed event has correct shape", () => {
		const event: AgentEvent = {
			type: "agent-failed",
			taskId: "cc-task-3",
			timestamp: new Date(),
			projectDir: "/tmp/project",
		};

		expect(event.type).toBe("agent-failed");
	});

	test("elapsed is optional", () => {
		const event: AgentEvent = {
			type: "agent-completed",
			taskId: "task-1",
			timestamp: new Date(),
			projectDir: "/tmp/proj",
		};

		expect(event.elapsed).toBeUndefined();
	});
});

describe("EventEmitter fires agent lifecycle events", () => {
	test("emit fires event to single subscriber", async () => {
		const vscode = await import("vscode");
		const emitter = new (
			vscode as unknown as {
				EventEmitter: new () => {
					event: (listener: (e: AgentEvent) => void) => { dispose: () => void };
					fire: (data: AgentEvent) => void;
					dispose: () => void;
				};
			}
		).EventEmitter();

		const received: AgentEvent[] = [];
		emitter.event((e: AgentEvent) => received.push(e));

		const event: AgentEvent = {
			type: "agent-started",
			taskId: "t1",
			timestamp: new Date(),
			projectDir: "/proj",
		};
		emitter.fire(event);

		expect(received).toHaveLength(1);
		expect(received[0]?.type).toBe("agent-started");
		expect(received[0]?.taskId).toBe("t1");

		emitter.dispose();
	});

	test("multiple subscribers all receive events", async () => {
		const vscode = await import("vscode");
		const emitter = new (
			vscode as unknown as {
				EventEmitter: new () => {
					event: (listener: (e: AgentEvent) => void) => { dispose: () => void };
					fire: (data: AgentEvent) => void;
					dispose: () => void;
				};
			}
		).EventEmitter();

		const received1: AgentEvent[] = [];
		const received2: AgentEvent[] = [];
		emitter.event((e: AgentEvent) => received1.push(e));
		emitter.event((e: AgentEvent) => received2.push(e));

		const event: AgentEvent = {
			type: "agent-completed",
			taskId: "t2",
			timestamp: new Date(),
			projectDir: "/proj",
			elapsed: "3m",
		};
		emitter.fire(event);

		expect(received1).toHaveLength(1);
		expect(received2).toHaveLength(1);
		expect(received1[0]).toBe(event);
		expect(received2[0]).toBe(event);

		emitter.dispose();
	});

	test("no events fire after dispose", async () => {
		const vscode = await import("vscode");
		const emitter = new (
			vscode as unknown as {
				EventEmitter: new () => {
					event: (listener: (e: AgentEvent) => void) => { dispose: () => void };
					fire: (data: AgentEvent) => void;
					dispose: () => void;
				};
			}
		).EventEmitter();

		const received: AgentEvent[] = [];
		emitter.event((e: AgentEvent) => received.push(e));

		emitter.dispose();

		emitter.fire({
			type: "agent-failed",
			taskId: "t3",
			timestamp: new Date(),
			projectDir: "/proj",
		});

		expect(received).toHaveLength(0);
	});

	test("dispose on subscription removes only that listener", async () => {
		const vscode = await import("vscode");
		const emitter = new (
			vscode as unknown as {
				EventEmitter: new () => {
					event: (listener: (e: AgentEvent) => void) => { dispose: () => void };
					fire: (data: AgentEvent) => void;
					dispose: () => void;
				};
			}
		).EventEmitter();

		const received1: AgentEvent[] = [];
		const received2: AgentEvent[] = [];
		const sub1 = emitter.event((e: AgentEvent) => received1.push(e));
		emitter.event((e: AgentEvent) => received2.push(e));

		sub1.dispose();

		emitter.fire({
			type: "agent-started",
			taskId: "t4",
			timestamp: new Date(),
			projectDir: "/proj",
		});

		expect(received1).toHaveLength(0);
		expect(received2).toHaveLength(1);

		emitter.dispose();
	});

	test("event contains timestamp as Date instance", async () => {
		const vscode = await import("vscode");
		const emitter = new (
			vscode as unknown as {
				EventEmitter: new () => {
					event: (listener: (e: AgentEvent) => void) => { dispose: () => void };
					fire: (data: AgentEvent) => void;
					dispose: () => void;
				};
			}
		).EventEmitter();

		let receivedEvent: AgentEvent | undefined;
		emitter.event((e: AgentEvent) => {
			receivedEvent = e;
		});

		const now = new Date();
		emitter.fire({
			type: "agent-completed",
			taskId: "t5",
			timestamp: now,
			projectDir: "/proj",
		});

		expect(receivedEvent).toBeDefined();
		expect(receivedEvent?.timestamp).toBe(now);
		expect(receivedEvent?.timestamp).toBeInstanceOf(Date);

		emitter.dispose();
	});

	test("all three event types can be emitted", async () => {
		const vscode = await import("vscode");
		const emitter = new (
			vscode as unknown as {
				EventEmitter: new () => {
					event: (listener: (e: AgentEvent) => void) => { dispose: () => void };
					fire: (data: AgentEvent) => void;
					dispose: () => void;
				};
			}
		).EventEmitter();

		const types: string[] = [];
		emitter.event((e: AgentEvent) => types.push(e.type));

		const base = { taskId: "t1", timestamp: new Date(), projectDir: "/p" };
		emitter.fire({ ...base, type: "agent-started" });
		emitter.fire({ ...base, type: "agent-completed" });
		emitter.fire({ ...base, type: "agent-failed" });

		expect(types).toEqual(["agent-started", "agent-completed", "agent-failed"]);

		emitter.dispose();
	});
});

/**
 * PAR-66 / CP-27 — provider-level lifecycle event tests.
 *
 * The blocks above only verify the AgentEvent type shape and a raw mocked
 * vscode.EventEmitter; they never instantiate AgentStatusTreeProvider, so they
 * would not catch the provider regressing its onAgentEvent firing. These tests
 * close that gap: they subscribe to the REAL provider.onAgentEvent, drive
 * status transitions through the production checkCompletionNotifications()
 * (invoked by reload()), and assert the real emitted payloads.
 */
describe("AgentStatusTreeProvider.onAgentEvent (real event source)", () => {
	let h: ProviderHarness;
	let provider: ProviderHarness["provider"];

	beforeEach(() => {
		// createProviderHarness() re-establishes the node:fs / node:child_process
		// / port-detector module mocks (the file-level mock.restore() wiped them)
		// and builds a provider whose getConfiguration returns the production
		// defaults — agentStatus.notifications / onCompletion / onFailure all
		// default to true, so the agent-completed / agent-failed fire() branches
		// are reachable.
		h = createProviderHarness();
		provider = h.provider;
		// Avoid real `git` execution from the completed-notification diff summary.
		provider.getDiffSummary = () => null;
	});

	afterEach(() => {
		disposeHarness(h);
	});

	const seedRunning = (task: AgentEventTaskInput): void => {
		provider.readRegistry = () =>
			createMockRegistry({ [task.id]: createMockTask(task) });
		provider.reload();
	};

	const transitionTo = (task: AgentEventTaskInput): void => {
		provider.readRegistry = () =>
			createMockRegistry({ [task.id]: createMockTask(task) });
		provider.reload();
	};

	test("fires agent-completed with the real payload on running→completed", () => {
		const received: AgentEvent[] = [];
		const sub = provider.onAgentEvent((e) => received.push(e));

		const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
		seedRunning({ id: "cc-1", status: "running", started_at: startedAt });
		transitionTo({
			id: "cc-1",
			status: "completed",
			started_at: startedAt,
			project_dir: "/Users/test/projects/my-app",
			exit_code: 0,
		});

		const completed = received.find((e) => e.type === "agent-completed");
		expect(completed).toBeDefined();
		expect(completed?.taskId).toBe("cc-1");
		expect(completed?.projectDir).toBe("/Users/test/projects/my-app");
		expect(completed?.timestamp).toBeInstanceOf(Date);
		// formatElapsed(started_at) for a run started 5 minutes ago.
		expect(completed?.elapsed).toBe("5m");

		sub.dispose();
	});

	test("fires agent-failed with the real payload (no elapsed key in shape) on running→failed", () => {
		const received: AgentEvent[] = [];
		const sub = provider.onAgentEvent((e) => received.push(e));

		const startedAt = new Date(Date.now() - 60_000).toISOString();
		seedRunning({ id: "cc-2", status: "running", started_at: startedAt });
		transitionTo({
			id: "cc-2",
			status: "failed",
			started_at: startedAt,
			project_dir: "/Users/test/projects/beta",
			exit_code: 1,
		});

		const failed = received.find((e) => e.type === "agent-failed");
		expect(failed).toBeDefined();
		expect(failed?.taskId).toBe("cc-2");
		expect(failed?.projectDir).toBe("/Users/test/projects/beta");
		expect(failed?.timestamp).toBeInstanceOf(Date);
		// The agent-failed fire() site does not populate `elapsed`.
		expect(failed?.elapsed).toBeUndefined();

		sub.dispose();
	});

	test("fires agent-started with the real payload on completed→running", () => {
		const received: AgentEvent[] = [];
		const sub = provider.onAgentEvent((e) => received.push(e));

		// Establish a previousStatus that is not "running" so the started branch
		// (prev !== undefined && prev !== "running") is reachable.
		transitionTo({
			id: "cc-3",
			status: "completed",
			project_dir: "/Users/test/projects/gamma",
		});
		transitionTo({
			id: "cc-3",
			status: "running",
			project_dir: "/Users/test/projects/gamma",
		});

		const started = received.find((e) => e.type === "agent-started");
		expect(started).toBeDefined();
		expect(started?.taskId).toBe("cc-3");
		expect(started?.projectDir).toBe("/Users/test/projects/gamma");
		expect(started?.timestamp).toBeInstanceOf(Date);

		sub.dispose();
	});

	test("does NOT fire on initial load (no previous status) nor on no-op reload", () => {
		const received: AgentEvent[] = [];
		const sub = provider.onAgentEvent((e) => received.push(e));

		// First appearance as completed: no prior status → no event.
		transitionTo({ id: "cc-4", status: "completed" });
		// Same status again: no transition → no event.
		provider.reload();

		expect(received).toHaveLength(0);

		sub.dispose();
	});

	test("REGRESSION: running→completed emits agent-completed via the provider, not just a mock emitter", () => {
		const received: AgentEvent[] = [];
		const sub = provider.onAgentEvent((e) => received.push(e));

		const startedAt = new Date(Date.now() - 3 * 60_000).toISOString();
		seedRunning({ id: "regress-1", status: "running", started_at: startedAt });
		transitionTo({
			id: "regress-1",
			status: "completed",
			started_at: startedAt,
			project_dir: "/Users/test/projects/regress",
			exit_code: 0,
		});

		// This assertion fails if the provider stops firing onAgentEvent — the
		// exact gap CP-27 describes that the mock-emitter-only blocks miss.
		const completedEvents = received.filter(
			(e) => e.type === "agent-completed",
		);
		expect(completedEvents).toHaveLength(1);
		expect(completedEvents[0]?.taskId).toBe("regress-1");
		expect(completedEvents[0]?.projectDir).toBe("/Users/test/projects/regress");
		expect(completedEvents[0]?.elapsed).toBe("3m");

		sub.dispose();
	});

	test("disposed subscription stops receiving provider events", () => {
		const received: AgentEvent[] = [];
		const sub = provider.onAgentEvent((e) => received.push(e));

		const firstStart = new Date(Date.now() - 2 * 60_000).toISOString();
		seedRunning({ id: "cc-5", status: "running", started_at: firstStart });
		transitionTo({
			id: "cc-5",
			status: "completed",
			started_at: firstStart,
			exit_code: 0,
		});
		expect(received).toHaveLength(1);

		sub.dispose();

		// A genuine new run (fresh started_at) would normally re-notify; after
		// dispose the listener must receive nothing further.
		const secondStart = new Date(Date.now() - 1 * 60_000).toISOString();
		seedRunning({ id: "cc-5", status: "running", started_at: secondStart });
		transitionTo({
			id: "cc-5",
			status: "completed",
			started_at: secondStart,
			exit_code: 0,
		});

		expect(received).toHaveLength(1);
	});
});
