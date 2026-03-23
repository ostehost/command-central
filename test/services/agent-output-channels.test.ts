/**
 * AgentOutputChannels Tests
 *
 * Tests OutputChannel creation, reuse, streaming lifecycle, and disposal.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Must set up mock before importing the module under test
beforeEach(() => {
	mock.restore();
	setupVSCodeMock();
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
			setTimeout(() => {}, 999999),
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
});
