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

	test("pending review status still wins over receipt-gap routing", () => {
		const dir = makeTmp();
		const task = makeTask({
			id: "review-status-wins",
			project_dir: dir,
			pending_review_path: path.join(dir, "missing-review.json"),
			review_status: "pending",
		});

		expect(groupOf(provider, task)).toBe("attention");
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
		expect(String(item.description)).not.toContain("review queue pending");
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
		).toContain("review queue pending");
	});
});
