/**
 * Agent Events Tests
 *
 * Tests the AgentEvent interface and the EventEmitter-based lifecycle events
 * fired by AgentStatusTreeProvider (agent-started, agent-completed, agent-failed).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentEvent } from "../../src/events/agent-events.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

let vscodeMock: ReturnType<typeof setupVSCodeMock>;

beforeEach(() => {
	mock.restore();
	vscodeMock = setupVSCodeMock();
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
		expect(received[0].type).toBe("agent-started");
		expect(received[0].taskId).toBe("t1");

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
		expect(receivedEvent!.timestamp).toBe(now);
		expect(receivedEvent!.timestamp).toBeInstanceOf(Date);

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
