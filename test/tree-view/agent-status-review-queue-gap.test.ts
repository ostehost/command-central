import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import type * as _fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof _fs;

const statSyncMock = mock((...args: unknown[]) =>
	(realFs.statSync as unknown as (...a: unknown[]) => unknown)(...args),
);
mock.module("node:fs", () => ({
	...realFs,
	statSync: statSyncMock,
}));

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
	type AgentStatusGroup,
	AgentStatusTreeProvider,
	type AgentTask,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import type { ReviewTracker } from "../../src/services/review-tracker.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

(globalThis as Record<string, unknown>)["__realAgentStatusReadRegistry"] ??=
	AgentStatusTreeProvider.prototype.readRegistry;
AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

const tmpDirs: string[] = [];
function makeTmp(): string {
	const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "review-gap-"));
	tmpDirs.push(dir);
	return dir;
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "review-gap-task",
		status: "completed",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-review-gap",
		tmux_session: "agent-review-gap",
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

function groupOf(
	provider: AgentStatusTreeProvider,
	task: AgentTask,
): AgentStatusGroup {
	const fn = (
		provider as unknown as {
			getNodeStatusGroup: (node: {
				type: "task";
				task: AgentTask;
			}) => AgentStatusGroup;
		}
	).getNodeStatusGroup.bind(provider);
	return fn({ type: "task", task });
}

describe("review queue continuation gap", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		mock.module("node:fs", () => ({
			...realFs,
			statSync: statSyncMock,
		}));
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFileSync: execFileSyncMock,
		}));
		statSyncMock.mockReset();
		statSyncMock.mockImplementation((...args: unknown[]) =>
			(realFs.statSync as unknown as (...a: unknown[]) => unknown)(...args),
		);
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
			if (cmd === "tmux" && args?.includes("has-session")) return "";
			if (cmd === "git") return "";
			if (
				cmd === "openclaw" &&
				args?.[0] === "tasks" &&
				args[1] === "audit" &&
				args[2] === "--json"
			) {
				return JSON.stringify({
					summary: {
						total: 0,
						warnings: 0,
						errors: 0,
						byCode: {},
					},
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
		const getConfigurationMock = mock((_section?: string) => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.groupByProject") return false;
				if (_key === "discovery.enabled") return false;
				return defaultValue;
			}),
			inspect: mock((_key: string) => undefined),
			has: mock((_key: string) => true),
		}));
		vscodeMock.workspace.getConfiguration =
			getConfigurationMock as unknown as typeof vscodeMock.workspace.getConfiguration;
		const runtimeVscode = require("vscode") as typeof import("vscode");
		runtimeVscode.workspace.getConfiguration =
			getConfigurationMock as unknown as typeof runtimeVscode.workspace.getConfiguration;

		provider = new AgentStatusTreeProvider({
			getIconForProject: mock(() => "P"),
			setCustomIcon: mock(() => Promise.resolve()),
		} as unknown as ConstructorParameters<typeof AgentStatusTreeProvider>[0]);
		provider.setReviewTracker(
			new InMemoryReviewTracker() as unknown as ReviewTracker,
		);
		provider.readRegistry = () => makeRegistry({});
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

	afterAll(() => {
		for (const dir of tmpDirs) {
			try {
				realFs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	test("completed task with present handoff and missing review receipt routes to limbo", () => {
		const dir = makeTmp();
		const handoff = path.join(dir, "HANDOFF.md");
		const receipt = path.join(dir, "missing-review.json");
		realFs.writeFileSync(handoff, "# done\n");
		const task = makeTask({
			id: "receipt-missing",
			project_dir: dir,
			handoff_file: handoff,
			pending_review_path: receipt,
		});

		expect(groupOf(provider, task)).toBe("limbo");
	});

	test("completed_stale with missing review receipt routes to attention", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "stale-receipt-missing",
			status: "completed_stale",
			project_dir: dir,
			pending_review_path: path.join(dir, "missing-review.json"),
		});

		expect(groupOf(provider, task)).toBe("attention");
		expect(
			String(provider.getTreeItem({ type: "task", task }).description),
		).toContain("review receipt missing");
	});

	test("pending review status with a present receipt routes to attention", () => {
		const dir = makeTmp();
		const receipt = path.join(dir, "present-review.json");
		realFs.writeFileSync(
			receipt,
			`${JSON.stringify({ status: "completed", review_state: "pending" })}\n`,
		);
		const task = makeTask({
			id: "review-status-wins",
			project_dir: dir,
			pending_review_path: receipt,
			review_status: "pending",
		});

		expect(groupOf(provider, task)).toBe("attention");
	});

	// CCSYNC-01 regression: a completed row that still CLAIMS pending review but
	// whose advertised receipt is MISSING locally and that has no live
	// pane/process evidence is a stale read-model projection — reconciliation
	// backlog, not attention-required work. It must land in Needs Review (limbo)
	// so it never inflates the activity-bar action badge.
	test("completed pending-review row with missing receipt and no live evidence is stale projection, not attention", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "stale-pending-projection",
			status: "completed",
			project_dir: dir,
			pending_review_path: path.join(dir, "missing-review.json"),
			review_status: "pending",
		});

		expect(groupOf(provider, task)).toBe("limbo");
	});

	test("completed_stale pending-review row with missing receipt and no live evidence is stale projection, not attention", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "stale-state-pending-projection",
			status: "completed_stale",
			project_dir: dir,
			pending_review_path: path.join(dir, "missing-review.json"),
			review_state: "pending",
		});

		expect(groupOf(provider, task)).toBe("limbo");
	});

	test("missing handoff wins over review receipt chip", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "missing-handoff-wins",
			project_dir: dir,
			handoff_file: "MISSING.md",
			pending_review_path: path.join(dir, "missing-review.json"),
		});
		const item = provider.getTreeItem({ type: "task", task });

		expect(String(item.description)).toContain("missing handoff: MISSING.md");
		expect(String(item.description)).not.toContain("review receipt missing");
	});

	test("detail row and inline chip explain missing review receipt", () => {
		const dir = makeTmp();
		const receipt = path.join(dir, "missing-review.json");
		const task = makeTask({
			id: "receipt-detail",
			project_dir: dir,
			pending_review_path: receipt,
		});

		const details = provider.getChildren({ type: "task", task });
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Review queue receipt not yet materialized" &&
					node.description === receipt,
			),
		).toBe(true);
		expect(
			String(provider.getTreeItem({ type: "task", task }).description),
		).toContain("review receipt missing");
	});

	// Source-of-truth regression suite (2026-06-12 screenshot bug): completed
	// node-origin tasks with review_state=reviewed / review_status=approved
	// rendered as "review receipt missing" because the consumed receipt was
	// probed on the wrong host — and even on the right host, after approval
	// the receipt's absence is the expected steady state.

	test("approved + reviewed task on the current host renders done despite consumed receipt", () => {
		__setCurrentMachineHostOverrideForTests("Lane Host");
		const dir = makeTmp();
		const task = makeTask({
			id: "approved-receipt-consumed",
			project_dir: dir,
			pending_review_path: path.join(dir, "consumed-receipt.json"),
			review_status: "approved",
			review_state: "reviewed",
			exec_mode: "hub",
			exec_host: "Lane Host",
		});

		expect(groupOf(provider, task)).toBe("done");
		expect(
			String(provider.getTreeItem({ type: "task", task }).description),
		).not.toContain("review receipt missing");
		const details = provider.getChildren({ type: "task", task });
		expect(
			details.some(
				(node) =>
					node.type === "detail" &&
					node.label === "Review queue receipt not yet materialized",
			),
		).toBe(false);
	});

	test("review_state=reviewed alone suppresses the receipt gap", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "reviewed-state-only",
			project_dir: dir,
			pending_review_path: path.join(dir, "consumed-receipt.json"),
			review_state: "reviewed",
		});

		expect(groupOf(provider, task)).toBe("done");
		expect(
			String(provider.getTreeItem({ type: "task", task }).description),
		).not.toContain("review receipt missing");
	});

	test("reviewed receipt archive suppresses stale review gap metadata", () => {
		const previous = process.env["CC_PENDING_REVIEW_DIR"];
		const baseDir = makeTmp();
		process.env["CC_PENDING_REVIEW_DIR"] = baseDir;
		try {
			const archived = path.join(baseDir, "reviewed", "archive-reviewed.json");
			realFs.mkdirSync(path.dirname(archived), { recursive: true });
			realFs.writeFileSync(
				archived,
				`${JSON.stringify({ status: "completed", review_state: "reviewed" })}\n`,
			);
			const task = makeTask({
				id: "archive-reviewed",
				project_dir: baseDir,
				pending_review_path: path.join(baseDir, "archive-reviewed.json"),
				review_state: "reviewing",
			});

			expect(groupOf(provider, task)).toBe("done");
			const description = String(
				provider.getTreeItem({ type: "task", task }).description,
			);
			expect(description).toContain("✓");
			expect(description).not.toContain("review receipt missing");
		} finally {
			if (previous === undefined) delete process.env["CC_PENDING_REVIEW_DIR"];
			else process.env["CC_PENDING_REVIEW_DIR"] = previous;
		}
	});

	test("review-only lanes are not routed to limbo for their own consumed receipt", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "review-only-consumed-receipt",
			role: "reviewer",
			project_dir: dir,
			pending_review_path: path.join(dir, "missing-review.json"),
		});

		expect(groupOf(provider, task)).toBe("done");
		expect(
			String(provider.getTreeItem({ type: "task", task }).description),
		).not.toContain("review receipt missing");
	});

	test("running reviewer lane with delivered handoff finalizes as no-review-expected", () => {
		const dir = makeTmp();
		const handoff = path.join(dir, "research", "REVIEW-source.md");
		realFs.mkdirSync(path.dirname(handoff), { recursive: true });
		realFs.writeFileSync(handoff, "# review delivered\n");
		const task = makeTask({
			id: "review-source",
			status: "running",
			role: "reviewer",
			project_dir: dir,
			handoff_file: handoff,
			pending_review_path: path.join(dir, "review-source.json"),
		});
		provider.readRegistry = () => makeRegistry({ [task.id]: task });
		provider.reload();

		const root = provider.getChildren();
		const displayed = root.find(
			(node): node is Extract<typeof node, { type: "task" }> =>
				node.type === "task" && node.task.id === task.id,
		);
		expect(displayed?.task.status).toBe("completed");
		expect(displayed?.task.review_state).toBe("no_review_expected");
	});

	test("remote node-origin task never reports a local receipt gap", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const dir = makeTmp();
		const task = makeTask({
			id: "remote-node-task",
			project_dir: dir,
			pending_review_path: "/tmp/oste-pending-review/remote-node-task.json",
			exec_mode: "node",
			exec_host: "Node Mac",
		});

		expect(groupOf(provider, task)).toBe("done");
		expect(
			String(provider.getTreeItem({ type: "task", task }).description),
		).not.toContain("review receipt missing");
	});

	test("node-execution metadata without exec_host fails closed on local probes", () => {
		__setCurrentMachineHostOverrideForTests("Hub Mac");
		const dir = makeTmp();
		const task = makeTask({
			id: "node-no-host-task",
			project_dir: dir,
			pending_review_path: path.join(dir, "missing-review.json"),
			exec_mode: "node",
		});

		expect(groupOf(provider, task)).toBe("done");
		expect(
			String(provider.getTreeItem({ type: "task", task }).description),
		).not.toContain("review receipt missing");
	});
});
