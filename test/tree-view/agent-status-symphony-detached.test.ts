/**
 * PAR-195: Symphony-orchestrated completed lanes must not surface the
 * `⚠ detached` attention badge.
 *
 * Doctrine: a Symphony lane is launched by the Symphony daemon, which owns
 * completion via oste-complete.sh — NOT via session_key/callback_url. So a
 * completed Symphony lane is transport-level "detached" yet fully orchestrated;
 * it never needs manual observation. The `isSymphonyLane` predicate gates both
 * the routing label (softened copy, muted iconColor) and the ⚠ badge.
 *
 * Coverage:
 *   1. isSymphonyLane — pure predicate unit cases
 *   2. classifyCompletionRouting — Symphony lane gets muted copy, not charts.yellow
 *   3. Regression guard — non-Symphony developer lane still gets manual observation
 *   4. Reviewer lane unaffected by Symphony change
 *   5. Running + detached Symphony lane untouched (fix is terminal-only)
 *   6. Render level — ⚠ badge suppressed for completed Symphony, present for non-Symphony
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Freeze real node built-ins before any mock.module() ─────────────────────
const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof import("node:fs");

mock.module("node:fs", () => realFs);

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

mock.module("../../src/utils/tmux-pane-health.js", () => ({
	isTmuxPaneAgentAlive: mock(() => true),
	inspectTmuxPaneAgent: mock(() => "unknown" as "alive" | "dead" | "unknown"),
	inspectTmuxPaneById: mock(() => "unknown" as "alive" | "dead" | "unknown"),
	AGENT_PROCESS_NAMES: ["codex", "claude"],
	PANE_ID_RE: /^%\d+$/,
}));

mock.module("../../src/utils/port-detector.js", () => ({
	detectListeningPorts: mock(() => []),
	detectListeningPortsAsync: mock(async () => []),
}));

// ── Imports (after mock.module) ──────────────────────────────────────────────
import {
	AgentStatusTreeProvider,
	type AgentTask,
	classifyCompletionRouting,
	type TaskRegistry,
} from "../../src/providers/agent-status-tree-provider.js";
import { isSymphonyLane } from "../../src/providers/agent-task-classification.js";
import type { ReviewTracker } from "../../src/services/review-tracker.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

AgentStatusTreeProvider.prototype.readRegistry = () => makeRegistry({});

function makeRegistry(tasks: Record<string, AgentTask> = {}): TaskRegistry {
	return { version: 2, tasks };
}

/** Minimal completed detached developer lane — no routing fields. */
function makeCompletedDetachedTask(
	overrides: Partial<AgentTask> = {},
): AgentTask {
	return {
		id: "cc-foo-20260617",
		status: "completed",
		project_dir: "/tmp/project",
		project_name: "project",
		session_id: "agent-foo",
		tmux_session: "agent-foo",
		bundle_path: "(tmux-mode)",
		prompt_file: "",
		started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
		completed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
		attempts: 1,
		max_attempts: 3,
		terminal_backend: "tmux",
		session_key: null,
		callback_url: null,
		role: "developer",
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

// ── 1. isSymphonyLane — pure predicate ──────────────────────────────────────

describe("isSymphonyLane — pure predicate", () => {
	test("canonical symphony-<ticket>-<hash> id → true", () => {
		expect(
			isSymphonyLane({
				id: "symphony-PAR-195-19fde801",
				orchestration_mode: null,
			}),
		).toBe(true);
	});

	test("orchestration_mode 'symphony' with non-symphony id → true", () => {
		expect(
			isSymphonyLane({ id: "cc-bar-20260617", orchestration_mode: "symphony" }),
		).toBe(true);
	});

	test("orchestration_mode 'Symphony' (mixed-case) → true (case-insensitive)", () => {
		expect(
			isSymphonyLane({ id: "cc-bar-20260617", orchestration_mode: "Symphony" }),
		).toBe(true);
	});

	test("plain developer id, no orchestration_mode → false", () => {
		expect(
			isSymphonyLane({ id: "cc-foo-20260617", orchestration_mode: null }),
		).toBe(false);
	});

	test("review-... id, no orchestration_mode → false", () => {
		expect(
			isSymphonyLane({ id: "review-PAR-195-abc123", orchestration_mode: null }),
		).toBe(false);
	});

	test("undefined orchestration_mode with non-symphony id → false", () => {
		expect(
			isSymphonyLane({ id: "cc-foo-20260617", orchestration_mode: undefined }),
		).toBe(false);
	});

	test("orchestration_mode '  symphony  ' (whitespace) → true (trimmed)", () => {
		expect(
			isSymphonyLane({
				id: "cc-bar-20260617",
				orchestration_mode: "  symphony  ",
			}),
		).toBe(true);
	});

	test("orchestration_mode 'SYMPHONY' (all-caps) → true", () => {
		expect(
			isSymphonyLane({ id: "cc-bar-20260617", orchestration_mode: "SYMPHONY" }),
		).toBe(true);
	});
});

// ── 2–5. classifyCompletionRouting — Symphony + regression + reviewer + running

describe("classifyCompletionRouting — Symphony lane handling", () => {
	test("completed Symphony lane (symphony-id) → muted detached, 'no action needed', disabledForeground", () => {
		const task = makeCompletedDetachedTask({
			id: "symphony-PAR-195-19fde801",
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("detached");
		expect(routing.label).toContain("no action needed");
		expect(routing.iconColor).toBe("disabledForeground");
		// Must NOT be the charts.yellow attention color
		expect(routing.iconColor).not.toBe("charts.yellow");
	});

	test("completed Symphony lane (orchestration_mode) → muted detached", () => {
		const task = makeCompletedDetachedTask({
			id: "cc-bar-20260617",
			orchestration_mode: "symphony",
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("detached");
		expect(routing.label).toContain("no action needed");
		expect(routing.iconColor).toBe("disabledForeground");
	});

	test("REGRESSION: completed non-Symphony developer lane → 'Detached — manual observation required' / charts.yellow", () => {
		// Ensure the fix does not silently mute unrelated developer lanes.
		const task = makeCompletedDetachedTask({
			id: "cc-foo-20260617",
			orchestration_mode: null,
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("detached");
		expect(routing.label).toBe("Detached — manual observation required");
		expect(routing.iconColor).toBe("charts.yellow");
	});

	test("completed reviewer lane unaffected → 'Detached — no action needed' / disabledForeground (existing behavior)", () => {
		const task = makeCompletedDetachedTask({
			id: "review-PAR-195-abc123",
			role: "reviewer",
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("detached");
		expect(routing.label).toBe("Detached — no action needed");
		expect(routing.detail).toContain("Standalone reviewer lane");
		expect(routing.iconColor).toBe("disabledForeground");
	});

	test("running + detached Symphony lane is unaffected (fix is terminal-only)", () => {
		// The running branch must still report generic "Detached" regardless of id.
		const task = makeCompletedDetachedTask({
			id: "symphony-PAR-195-19fde801",
			status: "running",
			completed_at: undefined,
		});
		const routing = classifyCompletionRouting(task);
		// Running detached is a legitimate live-visibility state — must stay yellow.
		expect(routing.kind).toBe("detached");
		expect(routing.label).toBe("Detached");
		expect(routing.iconColor).toBe("charts.yellow");
	});

	test("failed Symphony lane (status 'failed') also gets muted copy", () => {
		const task = makeCompletedDetachedTask({
			id: "symphony-PAR-195-19fde801",
			status: "failed",
		});
		const routing = classifyCompletionRouting(task);
		expect(routing.kind).toBe("detached");
		expect(routing.label).toContain("no action needed");
		expect(routing.iconColor).toBe("disabledForeground");
	});
});

// ── 6. Render level — ⚠ badge suppression ───────────────────────────────────

describe("row badge — ⚠ detached suppressed for completed Symphony lanes", () => {
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		mock.module("node:fs", () => realFs);
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFileSync: execFileSyncMock,
		}));
		mock.module("../../src/utils/port-detector.js", () => ({
			detectListeningPorts: mock(() => []),
			detectListeningPortsAsync: mock(async () => []),
		}));

		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[] | undefined];
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
		const getConfigurationMock = mock((_section?: string) => ({
			update: mock(),
			get: mock((_key: string, defaultValue?: unknown) => {
				if (_key === "agentStatus.groupByProject") return false;
				if (_key === "discovery.enabled") return false;
				if (_key === "laneRegistry.files") return [];
				return defaultValue;
			}),
			inspect: mock((_key: string) => undefined),
			has: mock((_key: string) => true),
		}));
		vscodeMock.workspace.getConfiguration =
			getConfigurationMock as unknown as typeof vscodeMock.workspace.getConfiguration;
		(require("vscode") as typeof import("vscode")).workspace.getConfiguration =
			getConfigurationMock as unknown as typeof import("vscode").workspace.getConfiguration;

		provider = new AgentStatusTreeProvider({
			getIconForProject: mock(() => "🎵"),
			setCustomIcon: mock(() => Promise.resolve()),
		} as unknown as ConstructorParameters<typeof AgentStatusTreeProvider>[0]);
		provider.setReviewTracker(
			new InMemoryReviewTracker() as unknown as ReviewTracker,
		);
		provider.readRegistry = () => makeRegistry({});
		provider.reload();
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

	function rowDescription(task: AgentTask): string {
		const item = provider.getTreeItem({ type: "task", task });
		return String(item.description ?? "");
	}

	test("completed detached Symphony lane (symphony-id) row does NOT show '⚠ detached'", () => {
		const task = makeCompletedDetachedTask({
			id: "symphony-PAR-195-19fde801",
		});
		expect(rowDescription(task)).not.toContain("⚠ detached");
	});

	test("completed detached Symphony lane (orchestration_mode) row does NOT show '⚠ detached'", () => {
		const task = makeCompletedDetachedTask({
			id: "cc-bar-20260617",
			orchestration_mode: "symphony",
		});
		expect(rowDescription(task)).not.toContain("⚠ detached");
	});

	test("REGRESSION: completed detached non-Symphony developer lane row DOES show '⚠ detached'", () => {
		const task = makeCompletedDetachedTask({
			id: "cc-foo-20260617",
			orchestration_mode: null,
		});
		expect(rowDescription(task)).toContain("⚠ detached");
	});

	test("completed reviewer lane row does NOT show '⚠ detached' (existing behavior unaffected)", () => {
		const task = makeCompletedDetachedTask({
			id: "review-PAR-195-abc123",
			role: "reviewer",
		});
		expect(rowDescription(task)).not.toContain("⚠ detached");
	});
});
