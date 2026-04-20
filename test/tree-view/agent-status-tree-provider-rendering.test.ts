/**
 * AgentStatusTreeProvider — rendering, icons, and metadata tests
 *
 * EXTRACTED from agent-status-tree-provider.test.ts. See
 * test/tree-view/_helpers/agent-status-tree-provider-test-base.ts for
 * shared mocks and the createProviderHarness() factory.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as path from "node:path";
import { OpenClawConfigService } from "../../src/services/openclaw-config-service.js";
import { ReviewTracker } from "../../src/services/review-tracker.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";
import {
	AgentStatusTreeProvider,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	type GitInfo,
	getFirstTask,
	type ProviderHarness,
	setAgentStatusConfig,
} from "./_helpers/agent-status-tree-provider-test-base.js";

// Real fs handle for tests that need to write tmp files (helper module
// remaps node:fs back to real fs at module-mock layer).
const fs = require("node:fs") as typeof import("node:fs");

describe("AgentStatusTreeProvider — rendering & metadata", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;
	let vscodeMock: ReturnType<typeof setupVSCodeMock>;

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		vscodeMock = h.vscodeMock;
	});

	afterEach(() => {
		disposeHarness(h);
	});

	describe("task item descriptions", () => {
		test("flat mode uses project metadata before falling back to activity", () => {
			setAgentStatusConfig(vscodeMock, { groupByProject: false });
			const task = createMockTask({
				status: "running",
				started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toBe("My App");
		});

		test("grouped mode falls back to relative activity when no diff or model is present", () => {
			setAgentStatusConfig(vscodeMock, { groupByProject: true });
			const task = createMockTask({
				status: "completed",
				started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
				completed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("1h ago");
			expect(item.description).not.toContain("My App");
		});
	});

	describe("git info in tree", () => {
		test("merged Git detail node appears when getGitInfo returns data", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = (_dir: string): GitInfo | null => ({
				branch: "feature/my-branch",
				lastCommit: "abc1234 fix: something (2m ago)",
			});
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const gitDetail = details.find(
				(d) => d.type === "detail" && d.icon === "git-branch",
			);
			expect(gitDetail).toBeDefined();
			if (gitDetail?.type === "detail") {
				expect(gitDetail.label).toContain("feature/my-branch");
				expect(gitDetail.label).toContain("abc1234");
			}
		});

		test("graceful fallback when git info is null (non-git dir)", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = (_dir: string): GitInfo | null => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const gitDetail = details.find(
				(d) => d.type === "detail" && d.icon === "git-branch",
			);
			expect(gitDetail).toBeUndefined();
		});

		test("Git detail shows branch → hash format", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = (_dir: string): GitInfo | null => ({
				branch: "main",
				lastCommit: "def5678 chore: update deps (5h ago)",
			});
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const gitDetail = details.find(
				(d) => d.type === "detail" && d.icon === "git-branch",
			);
			expect(gitDetail).toBeDefined();
			if (!gitDetail) {
				throw new Error("Git detail not found");
			}
			const gitItem = provider.getTreeItem(gitDetail);
			expect(gitItem.label).toBe("main · def5678");
		});

		test("Git detail prefers task end_commit over current HEAD", () => {
			const task = createMockTask({
				status: "completed",
				end_commit: "df10667abcdef1234567890",
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = (_dir: string): GitInfo | null => ({
				branch: "main",
				lastCommit: "41860d3 current head commit",
			});
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const gitDetail = details.find(
				(d) => d.type === "detail" && d.icon === "git-branch",
			);
			expect(gitDetail).toBeDefined();
			if (!gitDetail) {
				throw new Error("Git detail not found");
			}
			const gitItem = provider.getTreeItem(gitDetail);
			expect(gitItem.label).toBe("main · df10667");
		});
	});

	describe("per-project emoji icons", () => {
		let vscodeMock: ReturnType<typeof setupVSCodeMock>;

		beforeEach(() => {
			vscodeMock = setupVSCodeMock();
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.groupByProject") return false;
					if (_key === "discovery.enabled") return false;
					return defaultValue;
				}),
			}));
			vscodeMock.window.showInformationMessage = mock(() =>
				Promise.resolve(undefined),
			);
			vscodeMock.window.showWarningMessage = mock(() =>
				Promise.resolve(undefined),
			);
			provider = new AgentStatusTreeProvider();
			provider.readRegistry = () => createMockRegistry({});
			provider.reload();
		});

		test("emoji prepended when project config matches", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects") return [{ name: "my-app", emoji: "🫧" }];
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const task = createMockTask({
				project_dir: "/Users/test/projects/my-app",
			});
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).toContain("🫧");
			expect(item.label).toContain("test-task-1");
		});

		test("no emoji when no config match", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects")
						return [{ name: "other-project", emoji: "🛸" }];
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const task = createMockTask({
				project_dir: "/Users/test/projects/my-app",
			});
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).not.toContain("🛸");
			expect(item.label).toContain("test-task-1");
		});

		test("config with multiple projects works correctly", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects")
						return [
							{ name: "my-app", emoji: "🫧" },
							{ name: "api-server", emoji: "🛸" },
							{ name: "docs", emoji: "🪁" },
						];
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const task1 = createMockTask({
				id: "t1",
				project_dir: "/Users/test/projects/api-server",
			});
			const item1 = provider.getTreeItem({ type: "task", task: task1 });
			expect(item1.label).toContain("🛸");

			const task2 = createMockTask({
				id: "t2",
				project_dir: "/Users/test/projects/unknown",
			});
			const item2 = provider.getTreeItem({ type: "task", task: task2 });
			expect(item2.label).not.toContain("🛸");
			expect(item2.label).not.toContain("🫧");
			expect(item2.label).not.toContain("🪁");
			expect(item2.label).toContain("t2");
		});

		test("empty projects config returns no emoji", () => {
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "projects") return [];
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const task = createMockTask();
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.label).toContain("test-task-1");
		});
	});

	describe("hasAgentTasks context key", () => {
		let vscodeMock: ReturnType<typeof setupVSCodeMock>;

		beforeEach(() => {
			vscodeMock = setupVSCodeMock();
		});

		test("sets context key to false when no tasks", () => {
			provider.readRegistry = () => createMockRegistry({});
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.hasAgentTasks",
				false,
			);
		});

		test("sets context key to true when tasks exist", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.hasAgentTasks",
				true,
			);
		});

		test("context key updates on reload with changing tasks", () => {
			// Start with tasks
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.hasAgentTasks",
				true,
			);

			// Clear tasks
			provider.readRegistry = () => createMockRegistry({});
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.hasAgentTasks",
				false,
			);
		});

		test("sets terminal-task context key when terminal-state tasks exist", () => {
			const task = createMockTask({ status: "completed" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.agentStatus.hasTerminalTasks",
				true,
			);
		});

		test("clears terminal-task context key when only running tasks exist", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.reload();

			expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith(
				"setContext",
				"commandCentral.agentStatus.hasTerminalTasks",
				false,
			);
		});
	});

	describe("readPromptSummary", () => {
		test("returns cached value when prompt cache is populated", () => {
			const p = provider as unknown as { _promptCache: Map<string, string> };
			p._promptCache.clear();
			p._promptCache.set("/tmp/test.md", "Cached summary text");
			expect(provider.readPromptSummary("/tmp/test.md")).toBe(
				"Cached summary text",
			);
		});

		test("returns filename for nonexistent file", () => {
			const p = provider as unknown as { _promptCache: Map<string, string> };
			p._promptCache.clear();
			expect(provider.readPromptSummary("/nonexistent/path/spec.md")).toBe(
				"spec.md",
			);
		});

		test("caches results (second call returns same value)", () => {
			const p = provider as unknown as { _promptCache: Map<string, string> };
			p._promptCache.clear();
			// First call for nonexistent file caches the filename
			const first = provider.readPromptSummary("/no/such/file/task.md");
			const second = provider.readPromptSummary("/no/such/file/task.md");
			expect(first).toBe(second);
			expect(second).toBe("task.md");
		});

		test("prefers the Task section over orchestration boilerplate", () => {
			const p = provider as unknown as { _promptCache: Map<string, string> };
			p._promptCache.clear();
			const promptFile = path.join(
				"/tmp",
				`agent-status-prompt-${Date.now()}.md`,
			);
			fs.writeFileSync(
				promptFile,
				[
					"## Task Tracking",
					"At the START of your work, create a task to track it:",
					"- Use the task system to create a task with the subject matching your task_id",
					"",
					"# Task",
					"",
					"Fix Agent Status display bugs observed in the cc-agent-history-cap entry.",
				].join("\n"),
			);

			try {
				expect(provider.readPromptSummary(promptFile)).toBe(
					"Fix Agent Status display bugs observed in the cc-agent-history-cap entry.",
				);
			} finally {
				if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
			}
		});

		test("getDetailChildren shows prompt summary not raw file path", () => {
			// Use readPromptSummary override to avoid fs mock pollution in full suite
			provider.readPromptSummary = () => "Implement the widget factory";
			const task = createMockTask({
				status: "completed",
				exit_code: 0,
				prompt_file: "/tmp/some-spec.md",
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const promptDetail = details.find(
				(d) => d.type === "detail" && d.icon === "comment",
			);
			expect(promptDetail).toBeDefined();
			if (promptDetail?.type === "detail") {
				expect(promptDetail.label).toBe("Implement the widget factory");
				expect(promptDetail.label).not.toContain("/tmp/");
			}
		});
	});

	describe("reviewed state integration", () => {
		test("completed task shows reviewed badge in description after markTaskReviewed", () => {
			const task = createMockTask({
				status: "completed",
				completed_at: new Date(Date.now() - 120_000).toISOString(),
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.reload();

			// Before marking reviewed — no badge
			let item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("✓");
			expect(item.contextValue).toBe("agentTask.completed");

			// Mark reviewed
			provider.markTaskReviewed("test-task-1");

			item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("✓");
			expect(item.contextValue).toBe("agentTask.completed.reviewed");
		});

		test("reviewed completed task uses pass icon", () => {
			const task = createMockTask({
				status: "completed",
				completed_at: new Date(Date.now() - 120_000).toISOString(),
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.reload();

			provider.markTaskReviewed("test-task-1");

			const item = provider.getTreeItem({ type: "task", task });
			expect(item.iconPath).toBeDefined();
			const icon = item.iconPath as import("vscode").ThemeIcon;
			expect(icon.id).toBe("pass");
		});

		test("running task is not affected by markTaskReviewed", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.reload();

			provider.markTaskReviewed("test-task-1");

			// Running tasks don't get the reviewed badge
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("✓");
			expect(item.contextValue).toBe("agentTask.running");
		});

		test("setReviewTracker uses injected tracker instance", () => {
			const tmpDir = fs.mkdtempSync("/tmp/cc-review-tracker-");
			const storePath = path.join(tmpDir, "reviewed-tasks.json");
			try {
				const tracker = new ReviewTracker(storePath);
				tracker.markReviewed("test-task-1");
				provider.setReviewTracker(tracker);

				const task = createMockTask({
					status: "failed",
					completed_at: new Date(Date.now() - 60_000).toISOString(),
				});
				const item = provider.getTreeItem({ type: "task", task });
				expect(item.description).toContain("✓");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("task model details", () => {
		test("expanded task view shows explicit model detail", () => {
			const task = createMockTask({
				status: "running",
				model: "anthropic/claude-opus-4-6",
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const modelDetail = details.find(
				(d) => d.type === "detail" && d.icon === "hubot",
			);
			expect(modelDetail).toBeDefined();
			if (modelDetail?.type === "detail") {
				expect(modelDetail.label).toBe("opus");
			}
		});

		test("expanded task view shows inherited model detail", () => {
			const tmpDir = fs.mkdtempSync("/tmp/cc-openclaw-config-");
			const configPath = path.join(tmpDir, "openclaw.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					agents: {
						defaults: {
							model: {
								primary: "openai-codex/gpt-5.4",
							},
						},
						list: [{ id: "developer" }],
					},
				}),
			);

			try {
				const configService = new OpenClawConfigService(configPath);
				configService.reload();
				provider.setOpenClawConfigService(configService);

				const task = createMockTask({
					status: "running",
					role: "developer",
				});
				provider.readRegistry = () =>
					createMockRegistry({ "test-task-1": task });
				provider.getGitInfo = () => null;
				provider.getDiffSummary = () => null;
				provider.reload();

				const root = provider.getChildren();
				const firstTask = getFirstTask(root);
				const details = provider.getChildren(firstTask);
				const modelDetail = details.find(
					(d) => d.type === "detail" && d.icon === "hubot",
				);
				expect(modelDetail).toBeDefined();
				if (modelDetail?.type === "detail") {
					expect(modelDetail.label).toBe("codex-5.4");
				}
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("task description shows fallback when actual_model differs from model", () => {
			const task = createMockTask({
				status: "running",
				model: "anthropic/claude-opus-4-6",
				actual_model: "google/gemini-2.5-flash-lite",
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("(fallback)");
			// Should show the actual model alias, not the requested one
			expect(item.description).not.toContain("opus");
		});

		test("task description shows normal model when actual_model matches model", () => {
			const task = createMockTask({
				status: "running",
				model: "anthropic/claude-opus-4-6",
				actual_model: "anthropic/claude-opus-4-6",
			});
			provider.getDiffSummary = () => "2 files · +30 / -10";
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("fallback");
			expect(item.description).toContain("opus");
		});

		test("task description shows normal model when actual_model is absent", () => {
			const task = createMockTask({
				status: "running",
				model: "anthropic/claude-opus-4-6",
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("fallback");
			expect(item.description).toContain("opus");
		});

		test("expanded task detail shows fallback model info", () => {
			const task = createMockTask({
				status: "running",
				model: "anthropic/claude-opus-4-6",
				actual_model: "google/gemini-2.5-flash-lite",
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const modelDetail = details.find(
				(d) => d.type === "detail" && d.icon === "hubot",
			);
			expect(modelDetail).toBeDefined();
			if (modelDetail?.type === "detail") {
				expect(modelDetail.label).toContain("flash-lite");
				expect(modelDetail.label).toContain("(fallback from");
			}
		});
	});

	describe("surface clarity (backend-truthful labels)", () => {
		const tooltipText = (item: { tooltip?: unknown }): string => {
			const tip = item.tooltip as { value?: string } | string | undefined;
			if (!tip) return "";
			if (typeof tip === "string") return tip;
			return tip.value ?? "";
		};

		test("launcher-bundle tmux task: tooltip names surface, no description tag", () => {
			const task = createMockTask({
				status: "running",
				terminal_backend: "tmux",
				ghostty_bundle_id: "dev.partnerai.ghostty.my-app",
				bundle_path: "/Applications/Projects/My App.app",
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(tooltipText(item)).toContain("launcher Ghostty bundle");
			expect(item.description).not.toContain("fresh attach");
			expect(item.description).not.toContain("surface?");
		});

		test("tmux-only task: fresh-attach tag appears in description", () => {
			const task = createMockTask({
				status: "running",
				terminal_backend: "tmux",
				ghostty_bundle_id: null,
				bundle_path: "(tmux-mode)",
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("tmux · fresh attach");
			expect(tooltipText(item)).toContain(
				"no launcher bundle; focus spawns a fresh Ghostty attach",
			);
		});

		test("persist backend: description tagged and tooltip explains headless", () => {
			const task = createMockTask({
				status: "running",
				terminal_backend: "persist",
				bundle_path: "(tmux-mode)",
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("persist");
			expect(tooltipText(item)).toContain("persist backend");
			expect(tooltipText(item)).toContain("no visible Ghostty window");
		});

		test("unknown surface: surface? tag + tooltip disclosure", () => {
			const task = createMockTask({
				status: "running",
				terminal_backend: undefined,
				ghostty_bundle_id: null,
				bundle_path: "(tmux-mode)",
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("surface?");
			expect(tooltipText(item)).toContain(
				"no authoritative terminal surface recorded",
			);
		});

		test("completed tmux-only task: tooltip still shows surface, description omits tag", () => {
			const task = createMockTask({
				status: "completed",
				terminal_backend: "tmux",
				ghostty_bundle_id: null,
				bundle_path: "(tmux-mode)",
				started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
				completed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
			});
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			// Done tasks open a QuickPick, not a focus — tag would be noise.
			expect(item.description).not.toContain("fresh attach");
			expect(tooltipText(item)).toContain(
				"no launcher bundle; focus spawns a fresh Ghostty attach",
			);
		});
	});
});
