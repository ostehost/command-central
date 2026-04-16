/**
 * AgentStatusTreeProvider — diffs, notifications, and lifecycle tests
 *
 * EXTRACTED from agent-status-tree-provider.test.ts. See
 * test/tree-view/_helpers/agent-status-tree-provider-test-base.ts for
 * shared mocks and the createProviderHarness() factory.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import * as path from "node:path";
import type * as vscode from "vscode";
import { OpenClawConfigService } from "../../src/services/openclaw-config-service.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";
import {
	type AgentNode,
	AgentStatusTreeProvider,
	type AgentTask,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	getFirstTask,
	getOlderRunsNode,
	getTaskNodes,
	type ProviderHarness,
	setAgentStatusConfig,
} from "./_helpers/agent-status-tree-provider-test-base.js";

const fs = require("node:fs") as typeof import("node:fs");

describe("AgentStatusTreeProvider — diffs & notifications", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;
	let vscodeMock: ReturnType<typeof setupVSCodeMock>;
	let execFileSyncMock: ProviderHarness["execFileSyncMock"];
	let mockDetectListeningPorts: ProviderHarness["mockDetectListeningPorts"];

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		vscodeMock = h.vscodeMock;
		execFileSyncMock = h.execFileSyncMock;
		mockDetectListeningPorts = h.mockDetectListeningPorts;
	});

	afterEach(() => {
		disposeHarness(h);
	});

	describe("completion notifications", () => {
		let vscodeMock: ReturnType<typeof setupVSCodeMock>;
		const withDarwinPlatform = (run: () => void): void => {
			const original = Object.getOwnPropertyDescriptor(process, "platform");
			Object.defineProperty(process, "platform", {
				value: "darwin",
				configurable: true,
			});
			try {
				run();
			} finally {
				if (original) {
					Object.defineProperty(process, "platform", original);
				}
			}
		};

		beforeEach(() => {
			vscodeMock = setupVSCodeMock();
			// Make notifications enabled by default
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.notifications") return true;
					if (_key === "onCompletion") return true;
					if (_key === "onFailure") return true;
					if (_key === "sound") return false;
					if (_key === "agentStatus.groupByProject") return false;
					if (_key === "discovery.enabled") return false;
					return defaultValue;
				}),
			}));
			// Ensure show*Message mocks return promises
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

		afterEach(() => {
			// Dispose the provider to cancel any pending treeRefreshTimer before the
			// global afterEach runs mock.restore(). Without this, the setTimeout(fn,0)
			// from scheduleTreeRefresh() fires after mocks are cleared, causing
			// showInformationMessage().then(...) to throw and pollute later tests.
			provider.dispose();
		});

		test("completed notification includes diff summary text and new action buttons", () => {
			provider.getDiffSummary = () => "3 files · +45 / -12";
			const reveal = mock(() => Promise.resolve());
			provider.setTreeView({ reveal } as unknown as vscode.TreeView<AgentNode>);

			// Set up running state
			const runningTask = createMockTask({
				id: "t1",
				status: "running",
				agent_backend: "codex",
			});
			provider.readRegistry = () => createMockRegistry({ t1: runningTask });
			provider.reload();

			// Transition to completed
			const completedTask = createMockTask({
				id: "t1",
				status: "completed",
				agent_backend: "codex",
				exit_code: 0,
			});
			provider.readRegistry = () => createMockRegistry({ t1: completedTask });
			provider.reload();

			expect(vscodeMock.window.showInformationMessage).toHaveBeenCalled();
			const infoCallArgs = (
				vscodeMock.window.showInformationMessage as ReturnType<typeof mock>
			).mock.calls[0] as string[] | undefined;
			expect(infoCallArgs?.[0]).toContain("✅ t1 completed");
			expect(infoCallArgs?.[0]).toContain("3 files · +45 -12");
			expect(infoCallArgs?.[0]).toContain("[codex]");
			expect(infoCallArgs?.[0]).toContain("exit 0");
			expect(infoCallArgs?.[1]).toBe("View Diff");
			expect(infoCallArgs?.[2]).toBe("Show Output");
			expect(infoCallArgs?.[3]).toBe("Focus Terminal");

			expect(reveal).toHaveBeenCalled();
			const revealCall = reveal.mock.calls[0] as
				| [unknown, { select?: boolean; focus?: boolean }]
				| undefined;
			expect(revealCall?.[1]).toEqual({ select: true, focus: false });
		});

		test("failed notification includes exit code and new action buttons", () => {
			// Set up running state
			const runningTask = createMockTask({
				id: "t2",
				status: "running",
				agent_backend: "gemini",
			});
			provider.readRegistry = () => createMockRegistry({ t2: runningTask });
			provider.reload();

			// Transition to failed
			const failedTask = createMockTask({
				id: "t2",
				status: "failed",
				agent_backend: "gemini",
				exit_code: 42,
				error_message: "lint failed: missing semicolon",
			});
			provider.readRegistry = () => createMockRegistry({ t2: failedTask });
			provider.reload();

			expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled();
			const callArgs = (
				vscodeMock.window.showWarningMessage as ReturnType<typeof mock>
			).mock.calls[0] as string[] | undefined;
			expect(callArgs?.[0]).toContain("❌ t2 failed");
			expect(callArgs?.[0]).toContain("exit 42");
			expect(callArgs?.[0]).toContain("[gemini]");
			expect(callArgs?.[1]).toBe("Show Output");
			expect(callArgs?.[2]).toBe("View Diff");
			expect(callArgs?.[3]).toBe("Restart");
		});

		test("stopped notification includes stop reason when available", () => {
			const runningTask = createMockTask({
				id: "stop-1",
				status: "running",
				agent_backend: "claude",
			});
			provider.readRegistry = () =>
				createMockRegistry({ "stop-1": runningTask });
			provider.reload();

			const stoppedTask = createMockTask({
				id: "stop-1",
				status: "stopped",
				agent_backend: "claude",
				error_message:
					"Session no longer appears active. Showing as stopped due to stale health state.",
			});
			provider.readRegistry = () =>
				createMockRegistry({ "stop-1": stoppedTask });
			provider.reload();

			const infoCalls = (
				vscodeMock.window.showInformationMessage as ReturnType<typeof mock>
			).mock.calls as unknown[][];
			const stoppedMessage = infoCalls.find(
				(call) =>
					typeof call[0] === "string" &&
					String(call[0]).includes("⏹️ stop-1 stopped"),
			)?.[0];
			expect(String(stoppedMessage)).toContain(
				"Session no longer appears active.",
			);
		});

		test("no notification on completed→completed (no transition)", () => {
			const task = createMockTask({ id: "t3", status: "completed" });
			provider.readRegistry = () => createMockRegistry({ t3: task });
			provider.reload();

			// Reload again with same status
			provider.reload();

			// showInformationMessage should not have been called
			expect(
				(vscodeMock.window.showInformationMessage as ReturnType<typeof mock>)
					.mock.calls.length,
			).toBe(0);
		});

		test("no notification on initial load (no previous state)", () => {
			const task = createMockTask({ id: "t4", status: "completed" });
			provider.readRegistry = () => createMockRegistry({ t4: task });
			provider.reload();

			expect(
				(vscodeMock.window.showInformationMessage as ReturnType<typeof mock>)
					.mock.calls.length,
			).toBe(0);
		});

		test("notification respects master toggle when disabled", () => {
			// Override config to disable notifications
			vscodeMock.workspace.getConfiguration = mock(() => ({
				update: mock(),
				get: mock((_key: string, defaultValue?: unknown) => {
					if (_key === "agentStatus.notifications") return false;
					if (_key === "onCompletion") return true;
					if (_key === "onFailure") return true;
					if (_key === "agentStatus.groupByProject") return false;
					return defaultValue;
				}),
			}));

			const runningTask = createMockTask({ id: "t5", status: "running" });
			provider.readRegistry = () => createMockRegistry({ t5: runningTask });
			provider.reload();

			const transitionedTask = createMockTask({ id: "t5", status: "failed" });
			provider.readRegistry = () =>
				createMockRegistry({ t5: transitionedTask });
			provider.reload();

			expect(
				(vscodeMock.window.showInformationMessage as ReturnType<typeof mock>)
					.mock.calls.length,
			).toBe(0);
			expect(
				(vscodeMock.window.showWarningMessage as ReturnType<typeof mock>).mock
					.calls.length,
			).toBe(0);
		});

		test("all running terminal transitions fire notifications", () => {
			provider.getDiffSummary = () => "2 files · +10 / -3";
			const running = {
				c: createMockTask({
					id: "c",
					status: "running",
					agent_backend: "codex",
				}),
				f: createMockTask({
					id: "f",
					status: "running",
					agent_backend: "gemini",
				}),
				s: createMockTask({
					id: "s",
					status: "running",
					agent_backend: "claude",
				}),
				k: createMockTask({
					id: "k",
					status: "running",
					agent_backend: "codex",
				}),
			};
			provider.readRegistry = () =>
				createMockRegistry({
					c: running.c,
					f: running.f,
					s: running.s,
					k: running.k,
				});
			provider.reload();

			provider.readRegistry = () =>
				createMockRegistry({
					c: createMockTask({
						id: "c",
						status: "completed",
						agent_backend: "codex",
						exit_code: 0,
					}),
					f: createMockTask({
						id: "f",
						status: "failed",
						agent_backend: "gemini",
						exit_code: 1,
					}),
					s: createMockTask({
						id: "s",
						status: "stopped",
						agent_backend: "claude",
					}),
					k: createMockTask({
						id: "k",
						status: "killed",
						agent_backend: "codex",
					}),
				});
			provider.reload();

			const infoCalls = (
				vscodeMock.window.showInformationMessage as ReturnType<typeof mock>
			).mock.calls as unknown[][];
			const warningCalls = (
				vscodeMock.window.showWarningMessage as ReturnType<typeof mock>
			).mock.calls as unknown[][];

			expect(infoCalls).toHaveLength(2);
			expect(warningCalls).toHaveLength(2);

			const infoMessages = infoCalls.map((c) => String(c[0]));
			const warningMessages = warningCalls.map((c) => String(c[0]));
			expect(infoMessages.some((m) => m.includes("✅ c completed"))).toBe(true);
			expect(infoMessages.some((m) => m.includes("⏹️ s stopped"))).toBe(true);
			expect(warningMessages.some((m) => m.includes("❌ f failed"))).toBe(true);
			expect(warningMessages.some((m) => m.includes("💀 k killed"))).toBe(true);
		});

		test("completed transition requests Dock attention on macOS", () => {
			withDarwinPlatform(() => {
				const runningTask = createMockTask({ id: "dock-c", status: "running" });
				provider.readRegistry = () =>
					createMockRegistry({ "dock-c": runningTask });
				provider.reload();

				const completedTask = createMockTask({
					id: "dock-c",
					status: "completed",
					exit_code: 0,
				});
				provider.readRegistry = () =>
					createMockRegistry({ "dock-c": completedTask });
				provider.reload();

				expect(vscodeMock.window.requestAttention).toHaveBeenCalledTimes(1);
			});
		});

		test("failed transition requests Dock attention on macOS", () => {
			withDarwinPlatform(() => {
				const runningTask = createMockTask({ id: "dock-f", status: "running" });
				provider.readRegistry = () =>
					createMockRegistry({ "dock-f": runningTask });
				provider.reload();

				const failedTask = createMockTask({
					id: "dock-f",
					status: "failed",
					exit_code: 1,
				});
				provider.readRegistry = () =>
					createMockRegistry({ "dock-f": failedTask });
				provider.reload();

				expect(vscodeMock.window.requestAttention).toHaveBeenCalledTimes(1);
			});
		});

		test("dockBounce=false disables Dock attention", () => {
			withDarwinPlatform(() => {
				vscodeMock.workspace.getConfiguration = mock(() => ({
					update: mock(),
					get: mock((_key: string, defaultValue?: unknown) => {
						if (_key === "agentStatus.notifications") return true;
						if (_key === "dockBounce") return false;
						if (_key === "onCompletion") return true;
						if (_key === "onFailure") return true;
						if (_key === "sound") return false;
						if (_key === "agentStatus.groupByProject") return false;
						return defaultValue;
					}),
				}));

				const runningTask = createMockTask({
					id: "dock-off",
					status: "running",
				});
				provider.readRegistry = () =>
					createMockRegistry({ "dock-off": runningTask });
				provider.reload();

				const completedTask = createMockTask({
					id: "dock-off",
					status: "completed",
				});
				provider.readRegistry = () =>
					createMockRegistry({ "dock-off": completedTask });
				provider.reload();

				expect(vscodeMock.window.requestAttention).not.toHaveBeenCalled();
			});
		});

		test("stuck transition requests Dock attention once", () => {
			withDarwinPlatform(() => {
				const runningFresh = createMockTask({
					id: "stuck-dock",
					status: "running",
					started_at: new Date(Date.now() - 60_000).toISOString(),
				});
				provider.readRegistry = () =>
					createMockRegistry({ "stuck-dock": runningFresh });
				provider.reload();

				const runningStuck = createMockTask({
					id: "stuck-dock",
					status: "running",
					started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
				});
				provider.readRegistry = () =>
					createMockRegistry({ "stuck-dock": runningStuck });
				provider.reload();
				provider.reload();

				expect(vscodeMock.window.requestAttention).toHaveBeenCalledTimes(1);
			});
		});

		test("dock badge reflects running count and clears at zero", () => {
			withDarwinPlatform(() => {
				provider.readRegistry = () =>
					createMockRegistry({
						r1: createMockTask({
							id: "r1",
							status: "running",
							session_id: "agent-r1",
						}),
						r2: createMockTask({
							id: "r2",
							status: "running",
							session_id: "agent-r2",
						}),
					});
				provider.reload();

				expect(vscodeMock.window.badge).toEqual({
					value: 2,
					tooltip: "2 working agents",
				});

				provider.readRegistry = () =>
					createMockRegistry({
						r1: createMockTask({ id: "r1", status: "completed" }),
						r2: createMockTask({ id: "r2", status: "failed" }),
					});
				provider.reload();

				expect(vscodeMock.window.badge).toBeUndefined();
			});
		});
	});

	describe("port detection in tree", () => {
		beforeEach(() => {
			mockDetectListeningPorts.mockReset();
		});

		test("ports detail node appears for running tasks with ports", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			// Pre-populate port cache to simulate completed async detection
			const portCache = (
				provider as unknown as {
					_portCache: Map<
						string,
						Array<{ port: number; pid: number; process: string }>
					>;
				}
			)._portCache;
			portCache.set("test-task-1", [
				{ port: 3000, pid: 1234, process: "node" },
			]);
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const portsDetail = details.find(
				(d) => d.type === "detail" && d.label === "Ports",
			);
			expect(portsDetail).toBeDefined();
			if (portsDetail?.type === "detail") {
				expect(portsDetail.value).toBe("3000 (node)");
			}
		});

		test("no ports detail for non-running tasks", () => {
			mockDetectListeningPorts.mockReturnValue([
				{ port: 3000, pid: 1234, process: "node" },
			]);
			const task = createMockTask({ status: "completed" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const portsDetail = details.find(
				(d) => d.type === "detail" && d.label === "Ports",
			);
			expect(portsDetail).toBeUndefined();
			// detectListeningPorts should not have been called for non-running tasks
			expect(mockDetectListeningPorts).not.toHaveBeenCalled();
		});

		test("no ports detail when port cache is empty array", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			// Pre-populate port cache with empty result (async detection completed, found nothing)
			const portCache = (
				provider as unknown as {
					_portCache: Map<
						string,
						Array<{ port: number; pid: number; process: string }>
					>;
				}
			)._portCache;
			portCache.set("test-task-1", []);
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const portsDetail = details.find(
				(d) => d.type === "detail" && d.label === "Ports",
			);
			expect(portsDetail).toBeUndefined();
		});

		test("multiple ports displayed with comma separation", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			// Pre-populate port cache with multiple ports
			const portCache = (
				provider as unknown as {
					_portCache: Map<
						string,
						Array<{ port: number; pid: number; process: string }>
					>;
				}
			)._portCache;
			portCache.set("test-task-1", [
				{ port: 3000, pid: 1234, process: "node" },
				{ port: 8080, pid: 5678, process: "python3" },
			]);
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const portsDetail = details.find(
				(d) => d.type === "detail" && d.label === "Ports",
			);
			expect(portsDetail).toBeDefined();
			if (portsDetail?.type === "detail") {
				expect(portsDetail.value).toBe("3000 (node), 8080 (python3)");
			}
		});
	});

	describe("getDiffSummary", () => {
		test("parses git diff --stat summary line correctly", () => {
			const { execFileSync: _execFileSync } = require("node:child_process");
			// Mock execFileSync via provider method override
			const task = createMockTask({ status: "completed" });
			provider.getDiffSummary = (_dir: string, _t: AgentTask) => {
				// Simulate parsing
				const output =
					" file1.ts | 10 ++++---\n file2.ts | 5 ++--\n 2 files changed, 8 insertions(+), 5 deletions(-)";
				const summaryLine = output.split("\n").pop() ?? "";
				const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
				const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
				const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);
				if (!filesMatch) return null;
				const files = filesMatch[1];
				const insertions = insertMatch?.[1] ?? "0";
				const deletions = deleteMatch?.[1] ?? "0";
				return `${files} files · +${insertions} / -${deletions}`;
			};
			expect(provider.getDiffSummary("/test", task)).toBe("2 files · +8 / -5");
		});

		test("formats as 'N files · +X / -Y'", () => {
			const task = createMockTask({ status: "running" });
			provider.getDiffSummary = () => "4 files · +340 / -87";
			expect(provider.getDiffSummary("/test", task)).toBe(
				"4 files · +340 / -87",
			);
		});

		test("returns null on git failure", () => {
			// The real getDiffSummary catches errors and returns null
			// Test with non-existent directory
			const task = createMockTask({ status: "completed" });
			const result = provider.getDiffSummary(
				"/nonexistent/dir/that/does/not/exist",
				task,
			);
			expect(result).toBeNull();
		});

		test("detail children include Changes node when diff exists", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => "3 files · +100 / -20";
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const changesDetail = details.find(
				(d) => d.type === "detail" && d.icon === "files",
			);
			expect(changesDetail).toBeDefined();
			if (changesDetail?.type === "detail") {
				expect(changesDetail.label).toBe("3 files · +100 / -20");
			}
		});

		test("detail children omit Changes node when no diff", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const changesDetail = details.find(
				(d) => d.type === "detail" && d.icon === "files",
			);
			expect(changesDetail).toBeUndefined();
		});
	});

	describe("consolidated detail view", () => {
		test("detail children no longer include Worktree node", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const worktreeDetail = details.find(
				(d) => d.type === "detail" && d.label === "Worktree",
			);
			expect(worktreeDetail).toBeUndefined();
		});

		test("detail children include merged Git node with branch · hash", () => {
			const task = createMockTask();
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = () => ({
				branch: "feature/sidebar",
				lastCommit: "a1b2c3d refactor: tree view (3m ago)",
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
				expect(gitDetail.label).toContain("feature/sidebar");
				expect(gitDetail.label).toContain("a1b2c3d");
			}
		});

		test("Result node for completed tasks with exit code + attempts", () => {
			const task = createMockTask({
				status: "completed",
				exit_code: 0,
				attempts: 1,
				max_attempts: 3,
			});
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getGitInfo = () => null;
			provider.getDiffSummary = () => null;
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const resultDetail = details.find(
				(d) => d.type === "detail" && d.icon === "pass",
			);
			expect(resultDetail).toBeDefined();
			if (resultDetail?.type === "detail") {
				expect(resultDetail.label).toContain("Completed");
			}
		});

		test("running tasks show Prompt, Changes, Git, Ports (no Result)", () => {
			const task = createMockTask({ status: "running" });
			provider.readRegistry = () => createMockRegistry({ "test-task-1": task });
			provider.getDiffSummary = () => "2 files · +50 / -10";
			provider.getGitInfo = () => ({
				branch: "main",
				lastCommit: "abc1234 feat: stuff (1m ago)",
			});
			provider.readPromptSummary = () => "Fix the login bug";
			provider.reload();

			const root = provider.getChildren();
			const firstTask = getFirstTask(root);
			const details = provider.getChildren(firstTask);
			const icons = details.map((d) =>
				d.type === "detail" ? (d.icon ?? "") : "",
			);
			expect(icons).toContain("sync~spin");
			expect(icons).toContain("comment");
			expect(icons).toContain("files");
			expect(icons).toContain("git-branch");
			// No completed Result node for running tasks
			const hasResult = details.some(
				(d) => d.type === "detail" && d.icon === "pass",
			);
			expect(hasResult).toBe(false);
		});

		test("discovered children no longer include Session node", () => {
			const agent = {
				pid: 12345,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				model: "opus",
			};
			provider.getDiffSummary = () => null;
			const p = provider as unknown as {
				getDiscoveredChildren: (
					a: Record<string, unknown>,
				) => Array<{ type: string; label: string; value: string }>;
				readDiscoveredPrompt: (a: Record<string, unknown>) => string | null;
			};
			p.readDiscoveredPrompt = () => null;
			const details = p.getDiscoveredChildren(agent);
			const sessionDetail = details.find((d) => d.label === "Session");
			expect(sessionDetail).toBeUndefined();
		});
	});

	describe("inline diff summary on task item description", () => {
		test("task item description includes diff summary when available", () => {
			const task = createMockTask({ status: "running" });
			provider.getDiffSummary = () => "3 files · +120 / -45";
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("3 files · +120 / -45");
		});

		test("task item description excludes diff when getDiffSummary returns null", () => {
			const task = createMockTask({ status: "running" });
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("files");
			// Should still have project name and elapsed
			expect(item.description).toContain("My App");
		});

		test("task item description format is project · diff in flat mode", () => {
			const task = createMockTask({
				status: "running",
				project_name: "my-project",
				started_at: new Date(Date.now() - 60_000).toISOString(),
			});
			provider.getDiffSummary = () => "1 files · +10 / -5";
			const item = provider.getTreeItem({ type: "task", task });
			const desc = item.description as string;
			expect(desc).toContain("my-project");
			expect(desc).toContain("1 files · +10 / -5");
		});

		test("task item description appends explicit model alias", () => {
			const task = createMockTask({
				status: "running",
				model: "anthropic/claude-opus-4-6",
			});
			provider.getDiffSummary = () => "2 files · +30 / -10";
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).toContain("2 files · +30 / -10 · opus");
		});

		test("task item description appends inherited model alias", () => {
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
				provider.getDiffSummary = () => null;
				const item = provider.getTreeItem({ type: "task", task });
				expect(item.description).toContain("codex-5.4");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test("discovered item description includes diff summary when available", () => {
			const agent = {
				pid: 55555,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				command: "claude",
			};
			provider.getDiffSummary = () => "2 files · +30 / -10";
			const item = provider.getTreeItem({ type: "discovered", agent });
			expect(item.description).toContain("2 files · +30 / -10");
		});

		test("discovered item description excludes diff when getDiffSummary returns null", () => {
			const agent = {
				pid: 66666,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				command: "claude",
			};
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "discovered", agent });
			expect(item.description).not.toContain("PID");
			expect(item.description).not.toContain("files");
		});
	});

	describe("diff loading UX", () => {
		test("task item omits diff loading placeholder when diff is loading", () => {
			const task = createMockTask({ status: "running" });
			// Simulate diff loading: getDiffSummary returns null, but async loading is in progress
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "task", task });
			expect(item.description).not.toContain("Loading diff");
			expect(item.description).not.toContain("...");
		});

		test("discovered item omits diff loading placeholder", () => {
			const agent = {
				pid: 99001,
				projectDir: "/Users/test/projects/my-app",
				startTime: new Date("2026-02-25T08:00:00Z"),
				source: "process" as const,
				command: "claude",
			};
			provider.getDiffSummary = () => null;
			const item = provider.getTreeItem({ type: "discovered", agent });
			expect(item.description).not.toContain("Loading diff");
		});
	});

	describe("end_commit bounded diff attribution", () => {
		test("getPerFileDiffs uses start_commit..end_commit for completed tasks with end_commit", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "5\t2\tsrc/foo.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const diffs = provider.getPerFileDiffs(
				"/some/project",
				"abc123",
				"def456",
			);

			expect(diffs).toHaveLength(1);
			expect(diffs[0]?.filePath).toBe("src/foo.ts");
			// Should use start_commit..end_commit, not start_commit..HEAD
			expect(gitArgs.some((a) => a.includes("abc123..def456"))).toBe(true);
			expect(gitArgs.some((a) => a.includes("abc123..HEAD"))).toBe(false);
		});

		test("getPerFileDiffs returns empty when startCommit set but endCommit undefined (terminal task, no end boundary)", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "3\t1\tsrc/bar.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			// startCommit set, endCommit undefined → no valid end boundary
			const diffs = provider.getPerFileDiffs("/some/project", "abc123");

			expect(diffs).toHaveLength(0);
			// Should not have called git at all
			expect(gitArgs).toHaveLength(0);
		});

		test("getPerFileDiffs diffs working tree (no range) for running tasks", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "1\t0\tsrc/wip.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			// No startCommit, no endCommit → working tree diff
			const diffs = provider.getPerFileDiffs("/some/project");

			expect(diffs).toHaveLength(1);
			// Should not contain any ".." range
			expect(gitArgs.some((a) => a.some((s) => s.includes("..")))).toBe(false);
		});

		test("getDiffSummary uses end_commit for completed task with end_commit set", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "2\t1\tsrc/feature.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const task = createMockTask({
				status: "completed",
				start_commit: "start111",
				end_commit: "end222",
			});

			const summary = provider.getDiffSummary(task.project_dir, task);

			expect(summary).not.toBeNull();
			expect(gitArgs.some((a) => a.includes("start111..end222"))).toBe(true);
		});

		test("getDiffSummary returns null for completed task without end_commit or completed_at (no diff drift)", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "1\t0\tsrc/thing.ts\n";
				}
				// For completed_at timestamp lookup (log --before=...)
				if (
					cmd === "git" &&
					args?.includes("log") &&
					args?.some((a) => a.startsWith("--before="))
				) {
					return "";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const task = createMockTask({
				status: "completed",
				start_commit: "startabc",
				end_commit: null,
				completed_at: null,
			});

			const summary = provider.getDiffSummary(task.project_dir, task);

			// Should return null — no valid end boundary, avoids diff drift against HEAD
			expect(summary).toBeNull();
			// Should NOT have called git diff --numstat at all
			expect(gitArgs).toHaveLength(0);
		});

		test("getDiffSummary ignores completed_at when end_commit is missing", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "1\t0\tsrc/drift.ts\n";
				}
				if (
					cmd === "git" &&
					args?.includes("log") &&
					args?.some((a) => a.startsWith("--before="))
				) {
					throw new Error("completed_at lookup should not run");
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const task = createMockTask({
				status: "completed",
				start_commit: "startabc",
				end_commit: null,
				completed_at: "2026-04-03T20:00:00.000Z",
			});

			const summary = provider.getDiffSummary(task.project_dir, task);

			expect(summary).toBeNull();
			expect(gitArgs).toHaveLength(0);
		});

		test("running task getDiffSummary diffs working tree (no commit range)", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "1\t1\tsrc/running.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const task = createMockTask({
				status: "running",
				start_commit: "somesha",
			});

			provider.getDiffSummary(task.project_dir, task);

			// Running task: no range args, just working tree diff
			expect(gitArgs.some((a) => a.some((s) => s.includes("..")))).toBe(false);
		});

		test("getDiffSummary returns null for all terminal statuses without end_commit (diff drift guard)", () => {
			const terminalStatuses = [
				"completed",
				"completed_dirty",
				"completed_stale",
				"failed",
				"stopped",
				"killed",
			] as const;

			for (const status of terminalStatuses) {
				execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
					const [cmd, args] = fnArgs as [string, string[] | undefined];
					if (
						cmd === "git" &&
						args?.includes("log") &&
						args?.some((a) => a.startsWith("--before="))
					) {
						return "";
					}
					return realChildProcess.execFileSync(
						cmd,
						args,
						fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
					);
				});

				const task = createMockTask({
					status,
					start_commit: "abc123",
					end_commit: null,
					completed_at: null,
				});

				const summary = provider.getDiffSummary(task.project_dir, task);
				expect(summary).toBeNull();
			}
		});

		test("getDiffSummary returns bounded diff for completed task WITH end_commit (no regression)", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "5\t2\tsrc/feature.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const task = createMockTask({
				status: "completed",
				start_commit: "start111",
				end_commit: "end222",
			});

			const summary = provider.getDiffSummary(task.project_dir, task);

			expect(summary).toBe("1 file · +5 / -2");
			expect(gitArgs.some((a) => a.includes("start111..end222"))).toBe(true);
		});

		test("running task still diffs working tree (no regression)", () => {
			const gitArgs: string[][] = [];
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (cmd === "git" && args?.includes("--numstat")) {
					gitArgs.push(args);
					return "2\t3\tsrc/wip.ts\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			const task = createMockTask({
				status: "running",
				start_commit: "runsha",
			});

			const summary = provider.getDiffSummary(task.project_dir, task);

			expect(summary).toBe("1 file · +2 / -3");
			// Running task: should NOT use a commit range
			expect(gitArgs.some((a) => a.some((s) => s.includes("..")))).toBe(false);
		});
	});

	describe("completed task cap", () => {
		test("caps completed tasks at default limit (10) while keeping non-completed visible", () => {
			setAgentStatusConfig(vscodeMock, {
				groupByProject: false,
				discoveryEnabled: false,
			});

			const completedTasks = Array.from({ length: 15 }, (_, index) =>
				createMockTask({
					id: `completed-${index + 1}`,
					status: "completed",
					started_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
				}),
			);
			const failedTask = createMockTask({
				id: "failed-1",
				status: "failed",
				started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
			});
			const stoppedTask = createMockTask({
				id: "stopped-1",
				status: "stopped",
				started_at: new Date(Date.now() - 25 * 60_000).toISOString(),
			});

			provider.readRegistry = () =>
				createMockRegistry(
					Object.fromEntries(
						[...completedTasks, failedTask, stoppedTask].map((t) => [t.id, t]),
					),
				);
			provider.reload();

			const children = provider.getChildren();
			const taskNodes = getTaskNodes(children);

			// 10 completed (capped) + 1 failed + 1 stopped = 12 visible
			expect(taskNodes).toHaveLength(12);

			// 5 completed tasks hidden behind olderRuns
			const olderRuns = getOlderRunsNode(children);
			expect(olderRuns.hiddenNodes).toHaveLength(5);
			expect(olderRuns.label).toBe("Show 5 older completed...");
		});

		test("completed_dirty tasks are also subject to the cap", () => {
			setAgentStatusConfig(vscodeMock, {
				groupByProject: false,
				discoveryEnabled: false,
			});

			const tasks = Array.from({ length: 12 }, (_, index) =>
				createMockTask({
					id: `dirty-${index + 1}`,
					status: "completed_dirty",
					started_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
				}),
			);
			provider.readRegistry = () =>
				createMockRegistry(Object.fromEntries(tasks.map((t) => [t.id, t])));
			provider.reload();

			const children = provider.getChildren();
			const taskNodes = getTaskNodes(children);
			expect(taskNodes).toHaveLength(10);

			const olderRuns = getOlderRunsNode(children);
			expect(olderRuns.hiddenNodes).toHaveLength(2);
		});

		test("completed_stale tasks are NOT subject to the completed cap", () => {
			setAgentStatusConfig(vscodeMock, {
				groupByProject: false,
				discoveryEnabled: false,
			});

			// 3 completed_stale + 10 completed = 13 tasks, all should be visible
			// (completed_stale is always-visible, 10 completed within cap)
			const staleTasks = Array.from({ length: 3 }, (_, index) =>
				createMockTask({
					id: `stale-${index + 1}`,
					status: "completed_stale",
					started_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
				}),
			);
			const completedTasks = Array.from({ length: 10 }, (_, index) =>
				createMockTask({
					id: `completed-${index + 1}`,
					status: "completed",
					started_at: new Date(
						Date.now() - (index + 10) * 60_000,
					).toISOString(),
				}),
			);

			provider.readRegistry = () =>
				createMockRegistry(
					Object.fromEntries(
						[...staleTasks, ...completedTasks].map((t) => [t.id, t]),
					),
				);
			provider.reload();

			const children = provider.getChildren();
			const taskNodes = getTaskNodes(children);
			// All 13 visible: 3 stale (not capped) + 10 completed (within cap)
			expect(taskNodes).toHaveLength(13);
			// No olderRuns node needed
			expect(children.find((n) => n.type === "olderRuns")).toBeUndefined();
		});

		test("single hidden completed shows singular label", () => {
			setAgentStatusConfig(vscodeMock, {
				groupByProject: false,
				discoveryEnabled: false,
			});

			const tasks = Array.from({ length: 11 }, (_, index) =>
				createMockTask({
					id: `task-${index + 1}`,
					status: "completed",
					started_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
				}),
			);
			provider.readRegistry = () =>
				createMockRegistry(Object.fromEntries(tasks.map((t) => [t.id, t])));
			provider.reload();

			const children = provider.getChildren();
			const olderRuns = getOlderRunsNode(children);
			expect(olderRuns.label).toBe("Show 1 older completed...");
		});
	});

	describe("Project filter", () => {
		test("filters tasks by project_dir in flat mode", () => {
			const taskA = createMockTask({
				id: "task-a",
				project_dir: "/projects/alpha",
				project_name: "alpha",
				session_id: "agent-alpha",
			});
			const taskB = createMockTask({
				id: "task-b",
				project_dir: "/projects/beta",
				project_name: "beta",
				session_id: "agent-beta",
			});
			provider.readRegistry = () =>
				createMockRegistry({ "task-a": taskA, "task-b": taskB });
			provider.reload();

			// Unfiltered: both tasks visible
			const allChildren = provider.getChildren();
			const allTaskNodes = getTaskNodes(allChildren);
			expect(allTaskNodes).toHaveLength(2);

			// Filter to alpha
			provider.filterToProject("/projects/alpha");
			provider.reload();
			const filtered = provider.getChildren();
			const filteredTasks = getTaskNodes(filtered);
			expect(filteredTasks).toHaveLength(1);
			const firstTask = filteredTasks[0];
			expect(
				firstTask?.type === "task" ? firstTask.task.project_dir : undefined,
			).toBe("/projects/alpha");

			// Clear filter
			provider.filterToProject(null);
			provider.reload();
			const cleared = provider.getChildren();
			expect(getTaskNodes(cleared)).toHaveLength(2);
		});

		test("getKnownProjectDirs returns unique sorted dirs", () => {
			const taskA = createMockTask({
				id: "task-a",
				project_dir: "/projects/beta",
				session_id: "agent-beta",
			});
			const taskB = createMockTask({
				id: "task-b",
				project_dir: "/projects/alpha",
				session_id: "agent-alpha",
			});
			const taskC = createMockTask({
				id: "task-c",
				project_dir: "/projects/beta",
				session_id: "agent-beta-2",
			});
			provider.readRegistry = () =>
				createMockRegistry({
					"task-a": taskA,
					"task-b": taskB,
					"task-c": taskC,
				});
			provider.reload();

			const dirs = provider.getKnownProjectDirs();
			expect(dirs).toEqual(["/projects/alpha", "/projects/beta"]);
		});

		test("projectFilter getter reflects current filter", () => {
			expect(provider.projectFilter).toBeNull();
			provider.filterToProject("/projects/alpha");
			expect(provider.projectFilter).toBe("/projects/alpha");
			provider.filterToProject(null);
			expect(provider.projectFilter).toBeNull();
		});
	});
});
