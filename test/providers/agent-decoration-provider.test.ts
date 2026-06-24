/**
 * AgentDecorationProvider Tests
 *
 * Tests decoration lifecycle: marking changes, clearing, auto-expiry,
 * event firing, and URI scheme filtering.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

beforeEach(() => {
	mock.restore();
	setupVSCodeMock();
});

async function loadModule() {
	const mod = await import("../../src/providers/agent-decoration-provider.js");
	return mod;
}

describe("AgentDecorationProvider", () => {
	test("provides decoration for recently changed task", async () => {
		const { AgentDecorationProvider } = await loadModule();
		const provider = new AgentDecorationProvider();

		provider.markChanged("task-1");

		const uri = { scheme: "agent-task", path: "task-1" } as {
			scheme: string;
			path: string;
		};
		const decoration = provider.provideFileDecoration(uri as never);

		expect(decoration).toBeDefined();
		expect(decoration?.badge).toBe("●");
		expect(decoration?.tooltip).toBe("Recently changed");

		provider.dispose();
	});

	test("returns undefined for task without recent change", async () => {
		const { AgentDecorationProvider } = await loadModule();
		const provider = new AgentDecorationProvider();

		const uri = { scheme: "agent-task", path: "task-1" } as {
			scheme: string;
			path: string;
		};
		const decoration = provider.provideFileDecoration(uri as never);

		expect(decoration).toBeUndefined();

		provider.dispose();
	});

	test("returns undefined for non agent-task scheme", async () => {
		const { AgentDecorationProvider } = await loadModule();
		const provider = new AgentDecorationProvider();

		provider.markChanged("task-1");

		const uri = { scheme: "file", path: "task-1" } as {
			scheme: string;
			path: string;
		};
		const decoration = provider.provideFileDecoration(uri as never);

		expect(decoration).toBeUndefined();

		provider.dispose();
	});

	test("clearChange removes decoration", async () => {
		const { AgentDecorationProvider } = await loadModule();
		const provider = new AgentDecorationProvider();

		provider.markChanged("task-1");
		expect(provider.hasChange("task-1")).toBe(true);

		provider.clearChange("task-1");
		expect(provider.hasChange("task-1")).toBe(false);

		const uri = { scheme: "agent-task", path: "task-1" } as {
			scheme: string;
			path: string;
		};
		const decoration = provider.provideFileDecoration(uri as never);
		expect(decoration).toBeUndefined();

		provider.dispose();
	});

	test("markChanged fires onDidChangeFileDecorations event", async () => {
		const { AgentDecorationProvider } = await loadModule();
		const provider = new AgentDecorationProvider();

		let firedUri: unknown = null;
		provider.onDidChangeFileDecorations((uri) => {
			firedUri = uri;
		});

		provider.markChanged("task-1");

		expect(firedUri).toBeDefined();

		provider.dispose();
	});

	test("clearChange fires onDidChangeFileDecorations event", async () => {
		const { AgentDecorationProvider } = await loadModule();
		const provider = new AgentDecorationProvider();

		provider.markChanged("task-1");

		let firedUri: unknown = null;
		provider.onDidChangeFileDecorations((uri) => {
			firedUri = uri;
		});

		provider.clearChange("task-1");

		expect(firedUri).toBeDefined();

		provider.dispose();
	});

	test("decoration expires after TTL", async () => {
		const { AgentDecorationProvider } = await loadModule();
		const provider = new AgentDecorationProvider();

		// Manually set an expired timestamp
		const recentChanges = (
			provider as unknown as { recentChanges: Map<string, number> }
		).recentChanges;
		recentChanges.set("task-1", Date.now() - 31_000);

		const uri = { scheme: "agent-task", path: "task-1" } as {
			scheme: string;
			path: string;
		};
		const decoration = provider.provideFileDecoration(uri as never);

		expect(decoration).toBeUndefined();
		expect(provider.hasChange("task-1")).toBe(false);

		provider.dispose();
	});

	test("re-marking change within TTL is not cleared by the stale timer", async () => {
		// Regression for CP-40 / PAR-76: markChanged schedules an auto-clear
		// timer. If the same task is marked again within the TTL, the FIRST
		// (now stale) timer must not delete the NEWER decoration.
		const { AgentDecorationProvider } = await loadModule();

		// Capture every scheduled timer callback instead of waiting on the TTL.
		const scheduled: Array<() => void> = [];
		const realSetTimeout = globalThis.setTimeout;
		const realDateNow = Date.now;
		globalThis.setTimeout = ((cb: () => void) => {
			scheduled.push(cb);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		// Force distinct timestamps so the two marks are distinguishable.
		let clock = 1_000;
		Date.now = () => clock;

		try {
			const provider = new AgentDecorationProvider();

			provider.markChanged("task-1"); // schedules stale timer (ts=1000)
			clock = 2_000;
			provider.markChanged("task-1"); // re-mark within TTL (ts=2000)

			expect(scheduled.length).toBe(2);

			// Fire the FIRST (stale) timer — it must NOT clear the newer entry.
			scheduled[0]?.();
			expect(provider.hasChange("task-1")).toBe(true);

			const uri = { scheme: "agent-task", path: "task-1" } as {
				scheme: string;
				path: string;
			};
			expect(provider.provideFileDecoration(uri as never)).toBeDefined();

			// Fire the LATEST timer — it should clear normally.
			scheduled[1]?.();
			expect(provider.hasChange("task-1")).toBe(false);

			provider.dispose();
		} finally {
			globalThis.setTimeout = realSetTimeout;
			Date.now = realDateNow;
		}
	});

	test("re-marking completion within TTL is not cleared by the stale timer", async () => {
		// Regression for CP-40 / PAR-76: same defect in markCompleted's auto-clear.
		const { AgentDecorationProvider } = await loadModule();

		const scheduled: Array<() => void> = [];
		const realSetTimeout = globalThis.setTimeout;
		const realDateNow = Date.now;
		globalThis.setTimeout = ((cb: () => void) => {
			scheduled.push(cb);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		let clock = 1_000;
		Date.now = () => clock;

		try {
			const provider = new AgentDecorationProvider();

			provider.markCompleted("task-1", "completed"); // stale timer (ts=1000)
			clock = 2_000;
			provider.markCompleted("task-1", "failed"); // re-mark within TTL (ts=2000)

			expect(scheduled.length).toBe(2);

			// Fire the FIRST (stale) timer — must NOT clear the newer completion.
			scheduled[0]?.();
			expect(provider.hasCompletion("task-1")).toBe(true);

			const uri = { scheme: "agent-task", path: "task-1" } as {
				scheme: string;
				path: string;
			};
			expect(provider.provideFileDecoration(uri as never)).toBeDefined();

			// Fire the LATEST timer — it should clear normally.
			scheduled[1]?.();
			expect(provider.hasCompletion("task-1")).toBe(false);

			provider.dispose();
		} finally {
			globalThis.setTimeout = realSetTimeout;
			Date.now = realDateNow;
		}
	});

	test("dispose does not throw", async () => {
		const { AgentDecorationProvider } = await loadModule();
		const provider = new AgentDecorationProvider();

		provider.markChanged("task-1");

		expect(() => provider.dispose()).not.toThrow();
	});
});
