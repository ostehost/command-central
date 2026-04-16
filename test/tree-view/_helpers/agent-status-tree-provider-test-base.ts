/**
 * Shared test base for AgentStatusTreeProvider tests.
 *
 * The original `agent-status-tree-provider.test.ts` was 6,163 lines. To make
 * it navigable, themed describe blocks were extracted into sibling files
 * (`agent-status-tree-provider-{theme}.test.ts`). This module hosts the
 * shared module mocks, factories, and the per-test harness so each split
 * file remains short and focused.
 *
 * Module mocks at file scope are AUTO-APPLIED to any test file that imports
 * from this helper. Specifically:
 *   - node:fs is mocked back to real fs (so other test files that mock fs
 *     globally do not break our use of real tmp dirs)
 *   - node:child_process.execFileSync is mocked via execFileSyncMock (the
 *     default impl delegates to real execFileSync; per-test impls override)
 *   - ../../../src/utils/port-detector is mocked to return [] (no real lsof)
 *
 * Use `createProviderHarness()` in beforeEach to get the standard fixtures.
 */

import { mock } from "bun:test";
import * as realChildProcess from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

// ── Module mocks (auto-applied on import) ─────────────────────────────

// Keep importers on real node:fs even if other files in the worker mock it.
const fs = require("node:fs") as typeof import("node:fs");
mock.module("node:fs", () => fs);

const execFileSyncMock = mock((...fnArgs: unknown[]) =>
	realChildProcess.execFileSync(
		fnArgs[0] as string,
		fnArgs[1] as string[] | undefined,
		fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
	),
);

let openclawAuditJson = JSON.stringify({
	summary: {
		total: 0,
		warnings: 0,
		errors: 0,
		byCode: {
			stale_queued: 0,
			stale_running: 0,
			lost: 0,
			delivery_failed: 0,
			missing_cleanup: 0,
			inconsistent_timestamps: 0,
		},
	},
	findings: [],
});

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

const mockDetectListeningPorts = mock(
	() => [] as Array<{ port: number; pid: number; process: string }>,
);

mock.module("../../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mockDetectListeningPorts,
	detectListeningPortsAsync: mock(async () => mockDetectListeningPorts()),
}));

// ── Source imports (after mocks) ──────────────────────────────────────

import {
	type AgentNode,
	AgentStatusTreeProvider,
	type AgentTask,
	type TaskRegistry,
} from "../../../src/providers/agent-status-tree-provider.js";
import { setupVSCodeMock } from "../../helpers/vscode-mock.js";

// ── Type re-exports for split-file convenience ────────────────────────

export type {
	AgentNode,
	AgentRole,
	AgentStatusGroup,
	AgentTask,
	GitInfo,
	TaskRegistry,
} from "../../../src/providers/agent-status-tree-provider.js";
export { AgentStatusTreeProvider };

// ── Mock data factories ───────────────────────────────────────────────

export function createMockTask(overrides: Partial<AgentTask> = {}): AgentTask {
	const task: AgentTask = {
		id: "test-task-1",
		status: "running",
		project_dir: "/Users/test/projects/my-app",
		project_name: "My App",
		session_id: "agent-my-app",
		tmux_session: "agent-my-app",
		bundle_path: "/Applications/Projects/My App.app",
		prompt_file: "/tmp/task.md",
		started_at: new Date(Date.now() - 60_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		pr_number: null,
		review_status: null,
		...overrides,
	};

	if (task.terminal_backend === "persist" && !task.persist_socket) {
		task.persist_socket = getPersistSocketPath(task);
	}

	return task;
}

export function getPersistSocketPath(
	task: Pick<AgentTask, "session_id" | "persist_socket">,
): string {
	return (
		task.persist_socket ??
		path.join(
			os.homedir(),
			".local",
			"share",
			"cc",
			"sockets",
			`${task.session_id}.sock`,
		)
	);
}

export function getTmuxHealthCacheKey(
	task: Pick<AgentTask, "session_id" | "tmux_socket">,
): string {
	return `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
}

export function createMockRegistry(
	tasks: Record<string, AgentTask> = {},
): TaskRegistry {
	return { version: 2, tasks };
}

export function loadAgentStatusFixture(fileName: string): TaskRegistry {
	const fixturePath = path.join(
		process.cwd(),
		"test",
		"fixtures",
		"agent-status",
		fileName,
	);
	return JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as TaskRegistry;
}

const _DOGFOOD_RAW: TaskRegistry = loadAgentStatusFixture(
	"dogfood-live-tasks.json",
);

export function loadDogfoodFixture(): TaskRegistry {
	const fixture = _DOGFOOD_RAW;
	const nextTasks: Record<string, AgentTask> = {};
	let runningIndex = 0;
	const now = Date.now();

	for (const task of Object.values(fixture.tasks)) {
		if (task.status !== "running") {
			nextTasks[task.id] = task;
			continue;
		}

		runningIndex += 1;
		const id = `dogfood-running-${runningIndex}`;
		nextTasks[id] = {
			...task,
			id,
			started_at: new Date(now - runningIndex * 5 * 60_000).toISOString(),
			stream_file: `/tmp/command-central-fixtures/${id}.jsonl`,
		};
	}

	return {
		version: fixture.version,
		tasks: nextTasks,
	};
}

export class InMemoryReviewTracker {
	private reviewed = new Set<string>();
	markReviewed(taskId: string): void {
		this.reviewed.add(taskId);
	}
	isReviewed(taskId: string): boolean {
		return this.reviewed.has(taskId);
	}
	getReviewedIds(): Set<string> {
		return new Set(this.reviewed);
	}
	save(): void {}
}

// ── Tree-node accessors ───────────────────────────────────────────────

export function getTaskNodes(children: AgentNode[]): AgentNode[] {
	return children.filter((n) => n.type === "task");
}

export function getFirstTask(children: AgentNode[]): AgentNode {
	const task = children.find((n) => n.type === "task");
	if (!task) throw new Error("No task node found in children");
	return task;
}

export function getSummaryNode(
	children: AgentNode[],
): Extract<AgentNode, { type: "summary" }> {
	const summary = children.find(
		(n): n is Extract<AgentNode, { type: "summary" }> => n.type === "summary",
	);
	if (!summary) throw new Error("No summary node found in children");
	return summary;
}

export function getOlderRunsNode(
	children: AgentNode[],
): Extract<AgentNode, { type: "olderRuns" }> {
	const olderRuns = children.find(
		(node): node is Extract<AgentNode, { type: "olderRuns" }> =>
			node.type === "olderRuns",
	);
	if (!olderRuns) throw new Error("No older runs node found in children");
	return olderRuns;
}

export function setAgentStatusConfig(
	vscodeMock: ReturnType<typeof setupVSCodeMock>,
	options: {
		groupByProject?: boolean;
		projectGroup?: string;
		discoveryEnabled?: boolean;
	},
): void {
	const getConfigurationMock = mock((_section?: string) => ({
		update: mock(),
		get: mock((_key: string, defaultValue?: unknown) => {
			if (_key === "agentStatus.groupByProject") {
				return options.groupByProject ?? false;
			}
			if (_key === "project.group") {
				return options.projectGroup ?? defaultValue;
			}
			if (_key === "discovery.enabled") {
				return options.discoveryEnabled ?? false;
			}
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
}

// ── readRegistry pollution guard ──────────────────────────────────────
// Save the real method to globalThis BEFORE clobbering so tests in
// agent-status-tree-provider-read-registry.test.ts can recover it.

(globalThis as Record<string, unknown>)["__realAgentStatusReadRegistry"] ??=
	AgentStatusTreeProvider.prototype.readRegistry;
AgentStatusTreeProvider.prototype.readRegistry = () => createMockRegistry({});

// ── Provider harness ──────────────────────────────────────────────────

export interface ProjectIconManagerMock {
	getIconForProject: ReturnType<typeof mock>;
	setCustomIcon: ReturnType<typeof mock>;
}

export interface ProviderHarness {
	provider: AgentStatusTreeProvider;
	vscodeMock: ReturnType<typeof setupVSCodeMock>;
	projectIconManagerMock: ProjectIconManagerMock;
	execFileSyncMock: typeof execFileSyncMock;
	mockDetectListeningPorts: typeof mockDetectListeningPorts;
	setOpenclawAuditJson: (json: string) => void;
}

/**
 * Build the standard test fixture set used by most tree-provider tests.
 * Mirrors what the original parent describe's beforeEach did. Call this in
 * each describe's beforeEach; call `harness.provider.dispose()` in afterEach.
 *
 * Test-specific overrides:
 *   - To inject mock registry data: `harness.provider.readRegistry = () => createMockRegistry({...})`
 *   - To change config: `setAgentStatusConfig(harness.vscodeMock, { groupByProject: true })`
 *   - To control execFileSync: `harness.execFileSyncMock.mockImplementation(...)`
 */
export function createProviderHarness(): ProviderHarness {
	openclawAuditJson = JSON.stringify({
		summary: {
			total: 0,
			warnings: 0,
			errors: 0,
			byCode: {
				stale_queued: 0,
				stale_running: 0,
				lost: 0,
				delivery_failed: 0,
				missing_cleanup: 0,
				inconsistent_timestamps: 0,
			},
		},
		findings: [],
	});

	// Re-establish module mocks (global afterEach mock.restore() wipes them).
	mock.module("node:fs", () => fs);
	mock.module("node:child_process", () => ({
		...realChildProcess,
		execFileSync: execFileSyncMock,
	}));
	mock.module("../../../src/utils/port-detector.js", () => ({
		detectListeningPorts: mockDetectListeningPorts,
		detectListeningPortsAsync: mock(async () => mockDetectListeningPorts()),
	}));

	// Fully reset per-test (clear call history AND impl).
	execFileSyncMock.mockReset();
	mockDetectListeningPorts.mockReset();
	mockDetectListeningPorts.mockImplementation(() => []);

	execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
		const [cmd, args] = fnArgs as [string, string[] | undefined];
		if (cmd === "tmux" && args?.includes("has-session")) return "";
		if (cmd === "persist" && args?.[0] === "-s") return "";
		if (
			cmd === "openclaw" &&
			args?.[0] === "tasks" &&
			args[1] === "audit" &&
			args[2] === "--json"
		) {
			return openclawAuditJson;
		}
		return realChildProcess.execFileSync(
			cmd,
			args,
			fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
		);
	});

	const vscodeMock = setupVSCodeMock();
	const projectIconManagerMock: ProjectIconManagerMock = {
		getIconForProject: mock(() => "🧩"),
		setCustomIcon: mock(() => Promise.resolve()),
	};
	setAgentStatusConfig(vscodeMock, {});
	vscodeMock.window.showInformationMessage = mock(() =>
		Promise.resolve(undefined),
	);
	vscodeMock.window.showWarningMessage = mock(() => Promise.resolve(undefined));

	const provider = new AgentStatusTreeProvider(
		projectIconManagerMock as unknown as ConstructorParameters<
			typeof AgentStatusTreeProvider
		>[0],
	);
	provider.setReviewTracker(
		new InMemoryReviewTracker() as unknown as Parameters<
			typeof provider.setReviewTracker
		>[0],
	);
	provider.readRegistry = () => createMockRegistry({});
	provider.reload();

	return {
		provider,
		vscodeMock,
		projectIconManagerMock,
		execFileSyncMock,
		mockDetectListeningPorts,
		setOpenclawAuditJson: (json: string) => {
			openclawAuditJson = json;
		},
	};
}

/**
 * Standard afterEach helper. Disposes the provider safely even if the
 * test mocked `_agentRegistry` to an object without dispose().
 */
export function disposeHarness(h: ProviderHarness): void {
	const p = h.provider as unknown as { _agentRegistry: unknown };
	if (
		p._agentRegistry &&
		typeof (p._agentRegistry as { dispose?: unknown }).dispose !== "function"
	) {
		p._agentRegistry = null;
	}
	h.provider.dispose();
}
