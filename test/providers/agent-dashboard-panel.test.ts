/**
 * AgentDashboardPanel Tests
 *
 * Tests the webview dashboard panel: HTML generation, card rendering,
 * summary counts, section visibility, update behavior, and disposal.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Must set up vscode mock before importing the panel
let vscodeMock: ReturnType<typeof setupVSCodeMock>;

// Track the last created mock panel for assertions
let lastMockPanel: {
	webview: { html: string };
	reveal: ReturnType<typeof mock>;
	dispose: ReturnType<typeof mock>;
	onDidDispose: ReturnType<typeof mock>;
};

beforeEach(() => {
	mock.restore();
	vscodeMock = setupVSCodeMock();

	// Add createWebviewPanel mock that returns a panel with a writable webview
	lastMockPanel = {
		webview: { html: "" },
		reveal: mock(() => {}),
		dispose: mock(() => {}),
		onDidDispose: mock(
			(_cb: () => void, _thisArg?: unknown, _disposables?: unknown[]) => ({
				dispose: mock(() => {}),
			}),
		),
	};
	vscodeMock.window.createWebviewPanel = mock(
		() => lastMockPanel,
	) as unknown as typeof vscodeMock.window.createWebviewPanel;
});

import {
	AgentDashboardPanel,
	type GitInfoProvider,
} from "../../src/providers/agent-dashboard-panel.js";
import type { AgentTask } from "../../src/providers/agent-status-tree-provider.js";

// ── Mock data ────────────────────────────────────────────────────────

function createMockTask(overrides: Partial<AgentTask> = {}): AgentTask {
	return {
		id: "test-task-1",
		status: "running",
		project_dir: "/Users/test/projects/my-app",
		project_name: "My App",
		session_id: "agent-my-app",
		bundle_path: "/Applications/Projects/My App.app",
		prompt_file: "/tmp/task.md",
		started_at: "2026-02-25T08:00:00Z",
		attempts: 1,
		max_attempts: 3,
		pr_number: null,
		review_status: null,
		...overrides,
	};
}

// ── Panel creation tests ─────────────────────────────────────────────

describe("AgentDashboardPanel", () => {
	describe("show()", () => {
		test("creates webview panel with correct viewType", () => {
			const panel = new AgentDashboardPanel();
			panel.show({});

			expect(vscodeMock.window.createWebviewPanel).toHaveBeenCalledWith(
				"agentDashboard",
				"Agent Dashboard",
				1, // ViewColumn.One
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			panel.dispose();
		});

		test("reuses existing panel on subsequent calls", () => {
			const panel = new AgentDashboardPanel();
			panel.show({});
			panel.show({});

			// Should only create one panel
			expect(vscodeMock.window.createWebviewPanel).toHaveBeenCalledTimes(1);
			panel.dispose();
		});

		test("sets isVisible to true when panel is open", () => {
			const panel = new AgentDashboardPanel();
			expect(panel.isVisible).toBe(false);
			panel.show({});
			expect(panel.isVisible).toBe(true);
			panel.dispose();
		});

		test("calls reveal on panel", () => {
			const panel = new AgentDashboardPanel();
			panel.show({});
			expect(lastMockPanel.reveal).toHaveBeenCalled();
			panel.dispose();
		});
	});

	// ── HTML generation tests ──────────────────────────────────────────

	describe("getHtml()", () => {
		test("contains summary counts for empty tasks", () => {
			const panel = new AgentDashboardPanel();
			const html = panel.getHtml({});

			expect(html).toContain("Agent Dashboard");
			expect(html).toContain("No agents tracked yet.");
			panel.dispose();
		});

		test("contains correct total count", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "running" }),
				t2: createMockTask({ id: "t2", status: "running" }),
				t3: createMockTask({ id: "t3", status: "completed" }),
				t4: createMockTask({ id: "t4", status: "failed" }),
			};
			const html = panel.getHtml(tasks);

			// Should have summary section with total 4
			expect(html).toContain("summary-count");
			expect(html).toContain("Total");
			expect(html).toContain("Working");
			expect(html).toContain("Attention");
			expect(html).toContain("Done");
			panel.dispose();
		});

		test("shows attention hint when failed/stopped tasks exist", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				f1: createMockTask({ id: "f1", status: "failed" }),
				s1: createMockTask({ id: "s1", status: "stopped" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("agents need attention");
			expect(html).toContain(
				"Use Agent Actions in Agent Status tree to restart or inspect.",
			);
			panel.dispose();
		});

		test("does not show attention hint when only running/completed tasks exist", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				r1: createMockTask({ id: "r1", status: "running" }),
				c1: createMockTask({ id: "c1", status: "completed" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).not.toContain("needs attention");
			panel.dispose();
		});

		test("renders cards for each task", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				"task-alpha": createMockTask({
					id: "task-alpha",
					status: "running",
				}),
				"task-beta": createMockTask({
					id: "task-beta",
					status: "completed",
				}),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("task-alpha");
			expect(html).toContain("task-beta");
			panel.dispose();
		});

		test("renders Running section only when running tasks exist", () => {
			const panel = new AgentDashboardPanel();
			const tasksWithRunning: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "running" }),
			};
			const tasksNoRunning: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "completed" }),
			};

			expect(panel.getHtml(tasksWithRunning)).toContain("<h2>Running</h2>");
			expect(panel.getHtml(tasksNoRunning)).not.toContain("<h2>Running</h2>");
			panel.dispose();
		});

		test("renders Completed section only when completed tasks exist", () => {
			const panel = new AgentDashboardPanel();
			const tasksWithCompleted: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "completed" }),
			};
			const tasksNoCompleted: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "running" }),
			};

			expect(panel.getHtml(tasksWithCompleted)).toContain("<h2>Completed</h2>");
			expect(panel.getHtml(tasksNoCompleted)).not.toContain(
				"<h2>Completed</h2>",
			);
			panel.dispose();
		});

		test("renders Failed section only when failed tasks exist", () => {
			const panel = new AgentDashboardPanel();
			const tasksWithFailed: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "failed" }),
			};
			const tasksNoFailed: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "running" }),
			};

			expect(panel.getHtml(tasksWithFailed)).toContain("<h2>Failed</h2>");
			expect(panel.getHtml(tasksNoFailed)).not.toContain("<h2>Failed</h2>");
			panel.dispose();
		});

		test("renders Stopped section for stopped tasks only", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "stopped" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("<h2>Stopped</h2>");
			expect(html).toContain("t1");
			panel.dispose();
		});

		test("renders Failed section for failed, killed, and contract_failure tasks", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "failed" }),
				t2: createMockTask({ id: "t2", status: "killed" }),
				t3: createMockTask({ id: "t3", status: "contract_failure" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("<h2>Failed</h2>");
			expect(html).toContain("t1");
			expect(html).toContain("t2");
			expect(html).toContain("t3");
			panel.dispose();
		});

		test("renders status icons in cards", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "running" }),
				t2: createMockTask({ id: "t2", status: "completed" }),
				t3: createMockTask({ id: "t3", status: "failed" }),
				t4: createMockTask({ id: "t4", status: "completed_stale" }),
				t5: createMockTask({ id: "t5", status: "contract_failure" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("🔄");
			expect(html).toContain("✅");
			expect(html).toContain("❌");
			expect(html).toContain("⚠️");
			panel.dispose();
		});

		test("renders role icons when role is set", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", role: "developer" }),
				t2: createMockTask({ id: "t2", role: "reviewer" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("🔨"); // developer
			expect(html).toContain("🔍"); // reviewer
			panel.dispose();
		});

		test("renders project directory basename", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({
					id: "t1",
					project_dir: "/Users/test/projects/awesome-project",
				}),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("awesome-project");
			panel.dispose();
		});

		test("renders elapsed time", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({
					id: "t1",
					status: "running",
					started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
				}),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("Running for 5m");
			expect(html).not.toContain("Elapsed:");
			panel.dispose();
		});

		test("renders completed tasks using time since completion", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({
					id: "t1",
					status: "completed",
					started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
					completed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
				}),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("Completed 1h ago");
			expect(html).not.toContain("Elapsed:");
			expect(html).not.toContain("Completed 2h");
			panel.dispose();
		});

		test("renders failed and stopped tasks using time since completion", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				failed: createMockTask({
					id: "failed",
					status: "failed",
					started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
					completed_at: new Date(Date.now() - 30 * 60_000).toISOString(),
				}),
				stopped: createMockTask({
					id: "stopped",
					status: "stopped",
					started_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
					completed_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
				}),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("Failed 30m ago");
			expect(html).toContain("Stopped 2h ago");
			expect(html).not.toContain("Elapsed:");
			panel.dispose();
		});

		test("renders status badges", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "running" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain('class="status-badge running"');
			expect(html).toContain(">running</span>");
			panel.dispose();
		});

		test("renders human-readable labels for special statuses", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1", status: "completed_dirty" }),
				t2: createMockTask({ id: "t2", status: "completed_stale" }),
				t3: createMockTask({ id: "t3", status: "contract_failure" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain(">completed (dirty)</span>");
			expect(html).toContain(">completed (stale)</span>");
			expect(html).toContain(">contract failure</span>");
			panel.dispose();
		});

		test("uses failed color styling for killed status", () => {
			const panel = new AgentDashboardPanel();
			const html = panel.getHtml({
				t1: createMockTask({ id: "t1", status: "killed" }),
			});

			expect(html).toContain(
				".card.killed { border-left: 3px solid var(--vscode-charts-red); }",
			);
			expect(html).toContain(
				".status-badge.killed { background: var(--vscode-charts-red); color: white; }",
			);
			panel.dispose();
		});

		test("escapes HTML in task IDs", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: '<script>alert("xss")</script>' }),
			};
			const html = panel.getHtml(tasks);

			expect(html).not.toContain("<script>");
			expect(html).toContain("&lt;script&gt;");
			panel.dispose();
		});

		test("does not show empty message when tasks exist", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).not.toContain("No agents tracked yet.");
			panel.dispose();
		});

		test("uses VS Code CSS variables for theming", () => {
			const panel = new AgentDashboardPanel();
			const html = panel.getHtml({});

			expect(html).toContain("var(--vscode-foreground)");
			expect(html).toContain("var(--vscode-editor-background)");
			expect(html).toContain("var(--vscode-charts-blue)");
			expect(html).toContain("var(--vscode-charts-green)");
			expect(html).toContain("var(--vscode-charts-red)");
			panel.dispose();
		});
	});

	// ── Git info integration ───────────────────────────────────────────

	describe("git info", () => {
		test("renders branch when git info provider is set", () => {
			const panel = new AgentDashboardPanel();
			const gitProvider: GitInfoProvider = {
				getGitInfo: () => ({
					branch: "feature/dashboard",
					lastCommit: "abc1234 add dashboard",
				}),
			};
			panel.setGitInfoProvider(gitProvider);

			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).toContain("Branch: feature/dashboard");
			panel.dispose();
		});

		test("omits branch when git info is null", () => {
			const panel = new AgentDashboardPanel();
			const gitProvider: GitInfoProvider = {
				getGitInfo: () => null,
			};
			panel.setGitInfoProvider(gitProvider);

			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).not.toContain("Branch:");
			panel.dispose();
		});

		test("omits branch when no git info provider", () => {
			const panel = new AgentDashboardPanel();
			const tasks: Record<string, AgentTask> = {
				t1: createMockTask({ id: "t1" }),
			};
			const html = panel.getHtml(tasks);

			expect(html).not.toContain("Branch:");
			panel.dispose();
		});
	});

	// ── Update behavior ────────────────────────────────────────────────

	describe("update()", () => {
		test("refreshes HTML when panel is open", () => {
			const panel = new AgentDashboardPanel();
			panel.show({});

			panel.update({
				t1: createMockTask({ id: "updated-task", status: "completed" }),
			});

			// The webview html should contain the updated task
			expect(lastMockPanel.webview.html).toContain("updated-task");
			panel.dispose();
		});

		test("does nothing when panel is not open", () => {
			const panel = new AgentDashboardPanel();
			// No show() call — panel not created

			// Should not throw
			panel.update({
				t1: createMockTask({ id: "t1" }),
			});

			expect(vscodeMock.window.createWebviewPanel).not.toHaveBeenCalled();
			panel.dispose();
		});
	});

	// ── Disposal ───────────────────────────────────────────────────────

	describe("dispose()", () => {
		test("disposes panel and cleans up", () => {
			const panel = new AgentDashboardPanel();
			panel.show({});

			panel.dispose();

			expect(lastMockPanel.dispose).toHaveBeenCalled();
			expect(panel.isVisible).toBe(false);
		});

		test("handles dispose when no panel exists", () => {
			const panel = new AgentDashboardPanel();
			// Should not throw
			panel.dispose();
			expect(panel.isVisible).toBe(false);
		});
	});
});
