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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

/**
 * A lane that ran on a REMOTE node for the same logical project as the open
 * `workspace` folder — but whose absolute path lives under a different user's
 * home, so it can NEVER path-match the hub checkout. Identity is by project name.
 */
function makeRemoteNodeTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return makeTask({
		id: "remote-node-lane",
		status: "completed",
		project_dir: "/Users/othername/projects/workspace",
		project_name: "workspace",
		exec_host: "rocinante-node",
		exec_mode: "node",
		...overrides,
	});
}

/** A LOCAL lane actively in flight in the open workspace checkout. */
function makeLiveLocalTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return makeTask({
		id: "live-local-lane",
		status: "running",
		project_dir: WORKSPACE_DIR,
		project_name: "workspace",
		terminal_backend: "tmux",
		session_id: "agent-live-local",
		tmux_session: "agent-live-local",
		session_live: true,
		...overrides,
	});
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

	function findAllCards(root: AgentNode[]): SyncReadinessNode[] {
		return root.filter(
			(node): node is SyncReadinessNode => node.type === "syncReadiness",
		);
	}

	const scratchDirs: string[] = [];
	function syncReadinessScratchDir(): string {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "cc-sync-readiness-card-"),
		);
		scratchDirs.push(dir);
		process.env["CC_SYNC_READINESS_DIR"] = dir;
		return dir;
	}
	afterEach(() => {
		process.env["CC_SYNC_READINESS_DIR"] = "";
		for (const dir of scratchDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

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

	/** Install a registry and (optionally) a hub-host override, then reload. */
	function loadProjectTasks(
		tasks: AgentTask[],
		opts: { hubHost?: string } = {},
	): void {
		if (opts.hubHost) __setCurrentMachineHostOverrideForTests(opts.hubHost);
		const registry = makeRegistry(
			Object.fromEntries(tasks.map((t) => [t.id, t])),
		);
		provider.readRegistry = () => registry;
		provider.reload();
	}

	describe("remote-node identity + hub/node honesty (CCSYNC-04)", () => {
		test("a remote-node lane whose path diverges still yields an explicit node card", () => {
			syncReadinessEnabled = true;
			syncReadinessScratchDir(); // empty → no published receipt to find
			loadProjectTasks([makeRemoteNodeTask()], { hubHost: "hub-mac" });

			const receipts = provider.getSyncReadiness(WORKSPACE_DIR);
			// Both hosts represented: a live hub card AND an explicit node card.
			expect(receipts).toHaveLength(2);
			const hub = receipts.find((r) => r.reachability === "local-hub");
			const node = receipts.find((r) => r.reachability !== "local-hub");
			expect(hub?.ready).toBe(true); // hub checkout is clean (mocked git)
			expect(hub?.branch).toBe("main");

			// The node was never queried → explicit gap, NOT a fabricated green.
			expect(node?.host).toBe("rocinante-node");
			expect(node?.reachability).toBe("not-yet-queried");
			expect(node?.ready).toBe(false);
			expect(node?.branch).toBeNull();
			expect(node?.head).toBeNull();
			expect(node?.dirtyCount).toBeNull();
			expect(node?.blockers.map((b) => b.code)).toEqual(["not-yet-queried"]);
		});

		test("both cards render in the tree with distinct, stable ids", () => {
			syncReadinessEnabled = true;
			syncReadinessScratchDir();
			loadProjectTasks([makeRemoteNodeTask()], { hubHost: "hub-mac" });

			const cards = findAllCards(provider.getChildren());
			expect(cards).toHaveLength(2);
			const ids = cards.map((c) => provider.getTreeItem(c).id);
			expect(ids).toContain(`sync-readiness:${WORKSPACE_DIR}`);
			expect(ids).toContain(
				`sync-readiness:/Users/othername/projects/workspace:node:rocinante-node`,
			);
			// No duplicate ids (a duplicate id is a hard tree crash).
			expect(new Set(ids).size).toBe(ids.length);

			const nodeCard = cards.find(
				(c) => c.receipt.reachability !== "local-hub",
			);
			expect(nodeCard).toBeDefined();
			if (nodeCard) {
				const item = provider.getTreeItem(nodeCard);
				expect(item.label).toBe("Sync Readiness — workspace · rocinante-node");
				expect((item.iconPath as { id: string }).id).toBe("question");
			}
		});

		test("a published node receipt upgrades the node card to 'queried' with real facts", () => {
			syncReadinessEnabled = true;
			const dir = syncReadinessScratchDir();
			fs.writeFileSync(
				path.join(dir, "rocinante-node__workspace.json"),
				JSON.stringify({
					host: "rocinante-node",
					project: "workspace",
					projectDir: "/Users/othername/projects/workspace",
					branch: "feature/x",
					upstream: "origin/feature/x",
					head: "n0de77",
					tree: "tr88ee",
					porcelain: "",
					aheadBehind: "0\t0",
				}),
			);
			loadProjectTasks([makeRemoteNodeTask()], { hubHost: "hub-mac" });

			const node = provider
				.getSyncReadiness(WORKSPACE_DIR)
				.find((r) => r.reachability !== "local-hub");
			expect(node?.reachability).toBe("queried");
			expect(node?.ready).toBe(true);
			expect(node?.branch).toBe("feature/x");
			expect(node?.head).toBe("n0de77");
		});

		test("a live in-flight local lane blocks the hub card (live-terminal priority)", () => {
			syncReadinessEnabled = true;
			syncReadinessScratchDir();
			loadProjectTasks([makeLiveLocalTask()], { hubHost: "hub-mac" });

			const hub = provider
				.getSyncReadiness(WORKSPACE_DIR)
				.find((r) => r.reachability === "local-hub");
			expect(hub?.liveLaneCount).toBe(1);
			expect(hub?.ready).toBe(false);
			expect(hub?.blockers[0]?.code).toBe("live-lane");
		});

		test("a local lane in a worktree (divergent path, canonical match) still associates", () => {
			syncReadinessEnabled = true;
			syncReadinessScratchDir();
			// project_dir is a linked worktree path that does NOT equal the open
			// folder; canonical_project_dir points back to it. Exact-path matching
			// would have dropped this lane — canonical matching keeps it.
			const worktreeLane = makeLiveLocalTask({
				id: "worktree-lane",
				project_dir: "/Users/ostehost/worktrees/workspace-par229",
				canonical_project_dir: WORKSPACE_DIR,
			});
			loadProjectTasks([worktreeLane], { hubHost: "hub-mac" });

			const hub = provider
				.getSyncReadiness(WORKSPACE_DIR)
				.find((r) => r.reachability === "local-hub");
			// Associated despite the divergent project_dir → counted as live work.
			expect(hub?.liveLaneCount).toBe(1);
			expect(hub?.blockers[0]?.code).toBe("live-lane");
		});

		test("default off: a project with remote-node evidence still renders no card", () => {
			syncReadinessEnabled = false;
			syncReadinessScratchDir();
			loadProjectTasks([makeRemoteNodeTask()], { hubHost: "hub-mac" });
			expect(findAllCards(provider.getChildren())).toHaveLength(0);
		});
	});
});
