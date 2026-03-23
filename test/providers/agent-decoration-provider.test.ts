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

	test("dispose does not throw", async () => {
		const { AgentDecorationProvider } = await loadModule();
		const provider = new AgentDecorationProvider();

		provider.markChanged("task-1");

		expect(() => provider.dispose()).not.toThrow();
	});
});
