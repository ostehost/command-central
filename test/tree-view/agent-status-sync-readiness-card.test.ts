/**
 * Provider render coverage for the hub/node sync-readiness card (CCSYNC-04 /
 * PAR-229). The pure receipt → row/icon/tooltip logic is unit-tested in
 * test/services/sync-readiness-service.test.ts; here we prove the provider wiring:
 *
 *  - the card is OPT-IN: absent by default, present only when
 *    `commandCentral.syncReadiness.enabled` is `true` (default tree untouched);
 *  - when on, one card per workspace folder renders with a stable id, a
 *    collapsible item, and its evidence rows (branch, repo parity, working tree,
 *    review queue) beneath it.
 *
 * Git is mocked at `execFileSync`, so no real subprocess and no real repo state
 * leak into the assertions.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");

const execFileSyncMock = mock((...fnArgs: unknown[]) =>
	realChildProcess.execFileSync(
		fnArgs[0] as string,
		fnArgs[1] as string[] | undefined,
		fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
	),
);
mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mock(() => []),
	detectListeningPortsAsync: mock(async () => []),
}));

import {
	__setCurrentMachineHostOverrideForTests,
	type AgentNode,
	AgentStatusTreeProvider,
	type AgentTask,
	type SyncReadinessNode,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import type { ReviewTracker } from "../../src/services/review-tracker.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

(globalThis as Record<string, unknown>)["__realAgentStatusReadRegistry"] ??=
	AgentStatusTreeProvider.prototype.readRegistry;
AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

const WORKSPACE_DIR = "/mock/workspace";

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "sync-card-anchor-task",
		status: "completed",
		project_dir: "/tmp/some-other-project",
		project_name: "some-other-project",
		session_id: "agent-sync-card",
		tmux_session: "agent-sync-card",
		bundle_path: "",
		prompt_file: "",
		started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		terminal_backend: "tmux",
		handoff_file: null,
		pending_review_path: null,
		...overrides,
	};
}

/** Canned read-only git query replies for a clean repo at its upstream. */
function gitReply(args: string[] | undefined): string {
	const a = args ?? [];
	const rest = a[0] === "-C" ? a.slice(2) : a;
	const key = rest.join(" ");
	if (key === "rev-parse --abbrev-ref HEAD") return "main";
	if (key === "rev-parse --short HEAD^{tree}") return "def5678";
	if (key === "rev-parse --short HEAD") return "abc1234";
	if (key === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
		return "origin/main";
	}
	if (key === "status --porcelain") return "";
	if (key.startsWith("rev-list --left-right --count")) return "0\t0";
	return "";
}

class InMemoryReviewTracker {
	private reviewed = new Set<string>();
	markReviewed(id: string): void {
		this.reviewed.add(id);
	}
	isReviewed(id: string): boolean {
		return this.reviewed.has(id);
	}
	getReviewedIds(): Set<string> {
		return new Set(this.reviewed);
	}
	save(): void {}
}

describe("hub/node sync-readiness card", () => {
	let provider: AgentStatusTreeProvider;
	let syncReadinessEnabled: boolean;

	beforeEach(() => {
		syncReadinessEnabled = false;
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFileSync: execFileSyncMock,
		}));
		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "git") return gitReply(args);
			if (cmd === "tmux") return "";
			if (
				cmd === "openclaw" &&
				args?.[0] === "tasks" &&
				args[1] === "audit" &&
				args[2] === "--json"
			) {
				return JSON.stringify({
					summary: { total: 0, warnings: 0, errors: 0, byCode: {} },
					findings: [],
				});
			}
			return realChildProcess.execFileSync(
				cmd,
				args,
				fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
			);
		});

		const vscodeMock = setupVSCodeMock();
		const folders = [
			{ uri: { fsPath: WORKSPACE_DIR }, name: "workspace", index: 0 },
		];
		const getConfigurationMock = mock((_section?: string) => ({
			update: mock(),
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "agentStatus.groupByProject") return false;
				if (key === "discovery.enabled") return false;
				if (key === "laneRegistry.files") return [];
				if (key === "syncReadiness.enabled") return syncReadinessEnabled;
				return defaultValue;
			}),
			inspect: mock((_key: string) => undefined),
			has: mock((_key: string) => true),
		}));
		vscodeMock.workspace.getConfiguration =
			getConfigurationMock as unknown as typeof vscodeMock.workspace.getConfiguration;
		vscodeMock.workspace.workspaceFolders =
			folders as unknown as typeof vscodeMock.workspace.workspaceFolders;
		const runtimeVscode = require("vscode") as typeof import("vscode");
		runtimeVscode.workspace.getConfiguration =
			getConfigurationMock as unknown as typeof runtimeVscode.workspace.getConfiguration;
		(
			runtimeVscode.workspace as unknown as { workspaceFolders: unknown }
		).workspaceFolders = folders;

		provider = new AgentStatusTreeProvider({
			getIconForProject: mock(() => "P"),
			setCustomIcon: mock(() => Promise.resolve()),
		} as unknown as ConstructorParameters<typeof AgentStatusTreeProvider>[0]);
		provider.setReviewTracker(
			new InMemoryReviewTracker() as unknown as ReviewTracker,
		);
		const task = makeTask();
		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();
	});

	afterEach(() => {
		__setCurrentMachineHostOverrideForTests(null);
		const p = provider as unknown as { _agentRegistry: unknown };
		if (
			p._agentRegistry &&
			typeof (p._agentRegistry as { dispose?: unknown }).dispose !== "function"
		) {
			p._agentRegistry = null;
		}
		provider.dispose();
	});

	function findCard(root: AgentNode[]): SyncReadinessNode | undefined {
		return root.find(
			(node): node is SyncReadinessNode => node.type === "syncReadiness",
		);
	}

	test("default off: no card, Sources provenance row still present", () => {
		const root = provider.getChildren();
		expect(findCard(root)).toBeUndefined();
		// Sanity: the default provenance surface is untouched.
		expect(
			root.some((node) => node.type === "summary" && node.kind === "sources"),
		).toBe(true);
	});

	test("enabled: one ready hub card per workspace folder", () => {
		syncReadinessEnabled = true;
		const card = findCard(provider.getChildren());
		expect(card).toBeDefined();
		const receipt = card?.receipt;
		expect(receipt?.ready).toBe(true);
		expect(receipt?.project).toBe("workspace");
		expect(receipt?.branch).toBe("main");
		expect(receipt?.upstream).toBe("origin/main");
		expect(receipt?.dirtyCount).toBe(0);
		expect(receipt?.pendingReviewCount).toBe(0);
	});

	test("enabled: card item is collapsible with summary, icon, and stable id", () => {
		syncReadinessEnabled = true;
		const card = findCard(provider.getChildren());
		expect(card).toBeDefined();
		if (!card) return;
		const item = provider.getTreeItem(card);
		expect(item.label).toBe("Sync Readiness — workspace");
		expect(item.collapsibleState).toBe(1); // Collapsed
		expect(String(item.description)).toContain("main → origin/main");
		expect(String(item.description)).toContain("ready");
		expect((item.iconPath as { id: string }).id).toBe("pass-filled");
		expect(item.id).toBe(`sync-readiness:${WORKSPACE_DIR}`);
	});

	test("enabled: card children are the four evidence dimensions", () => {
		syncReadinessEnabled = true;
		const card = findCard(provider.getChildren());
		expect(card).toBeDefined();
		if (!card) return;
		const children = provider.getChildren(card);
		expect(children.every((node) => node.type === "state")).toBe(true);
		const byLabel = Object.fromEntries(
			children.map((node) =>
				node.type === "state" ? [node.label, node.description] : ["", ""],
			),
		);
		expect(byLabel["Branch"]).toBe("main → origin/main");
		expect(byLabel["Repo parity"]).toBe("in sync (0 ahead · 0 behind)");
		expect(byLabel["Working tree"]).toBe("clean");
		expect(byLabel["Review queue"]).toBe("clear");
	});
});
