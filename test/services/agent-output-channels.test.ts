/**
 * AgentOutputChannels Tests
 *
 * Tests OutputChannel creation, reuse, streaming lifecycle, and disposal.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");

// Records the `-t <session>` target tmux capture-pane was last invoked with so a
// session swap can be asserted. Set per test before triggering the interval.
let capturedSessionIds: string[] = [];

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: (_cmd: string, args: string[]) => {
		// ["capture-pane", "-t", <sessionId>, "-p"]
		const tIndex = args.indexOf("-t");
		const sessionId = tIndex >= 0 ? args[tIndex + 1] : undefined;
		if (sessionId !== undefined) capturedSessionIds.push(sessionId);
		return "line-1\nline-2\n";
	},
}));

// Must set up mock before importing the module under test
beforeEach(() => {
	mock.restore();
	setupVSCodeMock();
	capturedSessionIds = [];
});

// Dynamic import to pick up mocked vscode
async function loadModule() {
	// Clear module cache to get fresh import with current mocks
	const mod = await import("../../src/services/agent-output-channels.js");
	return mod;
}

describe("AgentOutputChannels", () => {
	afterEach(() => {
		mock.restore();
	});

	test("creates OutputChannel on first show", async () => {
		const { AgentOutputChannels } = await loadModule();
		const channels = new AgentOutputChannels();

		// Override startStreaming to prevent actual tmux calls
		(channels as unknown as { startStreaming: () => void }).startStreaming =
			() => {};

		channels.show("task-1", "valid-session");

		const channel = channels.getChannel("task-1");
		expect(channel).toBeDefined();

		channels.dispose();
	});

	test("reuses OutputChannel on subsequent shows", async () => {
		const { AgentOutputChannels } = await loadModule();
		const channels = new AgentOutputChannels();
		(channels as unknown as { startStreaming: () => void }).startStreaming =
			() => {};

		channels.show("task-1", "valid-session");
		const first = channels.getChannel("task-1");

		channels.show("task-1", "valid-session");
		const second = channels.getChannel("task-1");

		expect(first).toBe(second);

		channels.dispose();
	});

	test("rejects invalid session IDs", async () => {
		const { AgentOutputChannels } = await loadModule();
		const channels = new AgentOutputChannels();

		channels.show("task-1", "bad;injection");

		const channel = channels.getChannel("task-1");
		expect(channel).toBeUndefined();

		channels.dispose();
	});

	test("stopStreaming clears timer", async () => {
		const { AgentOutputChannels } = await loadModule();
		const channels = new AgentOutputChannels();

		// Manually start streaming state
		const timers = (
			channels as unknown as { timers: Map<string, NodeJS.Timeout> }
		).timers;
		timers.set(
			"task-1",
			setInterval(() => {}, 999999),
		);

		expect(channels.isStreaming("task-1")).toBe(true);

		channels.stopStreaming("task-1");

		expect(channels.isStreaming("task-1")).toBe(false);

		channels.dispose();
	});

	test("dispose cleans up all channels and timers", async () => {
		const { AgentOutputChannels } = await loadModule();
		const channels = new AgentOutputChannels();
		(channels as unknown as { startStreaming: () => void }).startStreaming =
			() => {};

		channels.show("task-1", "valid-session-1");
		channels.show("task-2", "valid-session-2");

		expect(channels.getChannel("task-1")).toBeDefined();
		expect(channels.getChannel("task-2")).toBeDefined();

		channels.dispose();

		expect(channels.getChannel("task-1")).toBeUndefined();
		expect(channels.getChannel("task-2")).toBeUndefined();
		expect(channels.isStreaming("task-1")).toBe(false);
		expect(channels.isStreaming("task-2")).toBe(false);
	});

	test("isStreaming returns false for unknown tasks", async () => {
		const { AgentOutputChannels } = await loadModule();
		const channels = new AgentOutputChannels();

		expect(channels.isStreaming("nonexistent")).toBe(false);

		channels.dispose();
	});

	// Regression for PAR-55 / CP-14: a second show() for the same task with a
	// replacement tmux session must retarget streaming to the NEW session. The
	// buggy implementation keyed startStreaming only by taskId and returned
	// early, so the interval kept polling the original session forever.
	test("switches streaming to a new session for an existing task", async () => {
		// Capture interval callbacks so they can be fired deterministically
		// instead of waiting on the real 2s poll.
		const intervalCallbacks: Array<() => void> = [];
		const originalSetInterval = globalThis.setInterval;
		globalThis.setInterval = ((
			cb: () => void,
			_ms?: number,
		): NodeJS.Timeout => {
			intervalCallbacks.push(cb);
			return { id: intervalCallbacks.length } as unknown as NodeJS.Timeout;
		}) as typeof setInterval;

		try {
			const { AgentOutputChannels } = await loadModule();
			const channels = new AgentOutputChannels();

			channels.show("task-1", "valid-session-1");
			// Fire the first session's poll.
			intervalCallbacks[intervalCallbacks.length - 1]?.();
			expect(capturedSessionIds).toContain("valid-session-1");

			// Same task, replacement session — must restart streaming.
			channels.show("task-1", "valid-session-2");
			// Fire the newest poll; it must target the new session.
			intervalCallbacks[intervalCallbacks.length - 1]?.();
			expect(capturedSessionIds).toContain("valid-session-2");

			channels.dispose();
		} finally {
			globalThis.setInterval = originalSetInterval;
		}
	});
});
