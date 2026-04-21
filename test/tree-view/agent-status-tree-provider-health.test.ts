/**
 * AgentStatusTreeProvider — runtime/health/stuck/dirty-exit tests
 *
 * EXTRACTED from agent-status-tree-provider.test.ts. See
 * test/tree-view/_helpers/agent-status-tree-provider-test-base.ts for
 * shared mocks and the createProviderHarness() factory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";

const realChildProcess = (globalThis as Record<string, unknown>)[
	"__realNodeChildProcess"
] as typeof import("node:child_process");

import * as path from "node:path";
import {
	type AgentStatusTreeProvider,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	getFirstTask,
	getPersistSocketPath,
	getTmuxHealthCacheKey,
	type ProviderHarness,
} from "./_helpers/agent-status-tree-provider-test-base.js";

// Real node:fs (the helper auto-mocks node:fs back to real fs).
const fs = require("node:fs") as typeof import("node:fs");

describe("AgentStatusTreeProvider — health & lifecycle", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;
	let execFileSyncMock: ProviderHarness["execFileSyncMock"];

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
		execFileSyncMock = h.execFileSyncMock;
	});

	afterEach(() => {
		disposeHarness(h);
	});

	describe("runtime health overlay for running status", () => {
		test("overlays stuck dead running tmux task as completed_stale for UI status/counts", () => {
			const task = createMockTask({
				id: "ghost-running",
				status: "running",
				terminal_backend: "tmux",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed_stale");

			const children = provider.getChildren();
			const summary = children.find((n) => n.type === "summary");
			expect(summary).toBeDefined();
			if (summary?.type === "summary") {
				expect(summary.label).toContain("1 ✓");
				expect(summary.label).not.toContain("1 working");
			}
			const taskNode = getFirstTask(children);
			const taskItem = provider.getTreeItem(taskNode);
			expect(taskItem.description).toContain("stale");
			const icon = taskItem.iconPath as { id: string; color?: { id: string } };
			expect(icon.id).toBe("warning");
			expect(icon.color?.id).toBe("charts.yellow");
			expect(taskItem.command?.command).toBe(
				"commandCentral.resumeAgentSession",
			);
		});

		test("still downgrades running tmux task when tmux session is unhealthy", () => {
			const task = createMockTask({
				id: "live-running",
				status: "running",
				terminal_backend: "tmux",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_allDiscoveredAgents: Array<{ sessionId?: string }>;
				}
			)._allDiscoveredAgents = [{ sessionId: task.session_id }];
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("stopped");
		});

		test("getStaleLauncherTasks returns the display-overlay stale tasks", () => {
			const task = createMockTask({
				id: "stale-listing",
				status: "running",
				terminal_backend: "tmux",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(
				provider.getStaleLauncherTasks().map((candidate) => candidate.id),
			).toEqual(["stale-listing"]);
		});

		test("uses terminal stream completion instead of stopped when session already finished", () => {
			const streamFile = path.join(
				"/tmp",
				`agent-status-completed-${Date.now()}.jsonl`,
			);
			const task = createMockTask({
				id: "stream-completed",
				status: "running",
				terminal_backend: "tmux",
				stream_file: streamFile,
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			fs.writeFileSync(
				streamFile,
				`${JSON.stringify({ type: "turn.completed" })}\n`,
			);
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});

			try {
				provider.readRegistry = () => createMockRegistry({ [task.id]: task });
				provider.reload();

				const displayTask = provider
					.getTasks()
					.find((candidate) => candidate.id === task.id);
				expect(displayTask?.status).toBe("completed");

				const taskNode = getFirstTask(provider.getChildren());
				const details = provider.getChildren(taskNode);
				expect(
					details.some(
						(child) =>
							child.type === "detail" && child.label === "Agent process ended",
					),
				).toBe(false);
			} finally {
				if (fs.existsSync(streamFile)) fs.unlinkSync(streamFile);
			}
		});

		test("downgrades unhealthy running persist task to stopped when socket is dead", () => {
			const task = createMockTask({
				id: "persist-running",
				status: "running",
				terminal_backend: "persist",
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("stopped");
		});

		test("displays completed instead of stopped when exit_code is 0 on dead persist task", () => {
			const task = createMockTask({
				id: "persist-completed-evidence",
				status: "running",
				terminal_backend: "persist",
				exit_code: 0,
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed");
		});

		test("displays failed instead of stopped when exit_code is non-zero on dead persist task", () => {
			const task = createMockTask({
				id: "persist-failed-evidence",
				status: "running",
				terminal_backend: "persist",
				exit_code: 1,
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("failed");
		});

		test("displays completed instead of stopped when completed_at is set on dead tmux task", () => {
			const task = createMockTask({
				id: "tmux-completed-at",
				status: "running",
				terminal_backend: "tmux",
				completed_at: new Date(Date.now() - 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed");
		});

		test("displays stopped when no completion evidence on dead persist task", () => {
			const task = createMockTask({
				id: "persist-no-evidence",
				status: "running",
				terminal_backend: "persist",
				// no exit_code, no completed_at
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("stopped");
		});

		test("tasks.json completed status is preserved regardless of session health", () => {
			const task = createMockTask({
				id: "already-completed",
				status: "completed",
				terminal_backend: "persist",
				exit_code: 0,
				completed_at: new Date(Date.now() - 60_000).toISOString(),
			});
			// Even though session is dead, status should stay completed
			// (the guard at the top of toDisplayTask handles this)
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed");
		});

		test("persist-backed running task shows as running when socket is alive", () => {
			const task = createMockTask({
				id: "persist-alive",
				status: "running",
				terminal_backend: "persist",
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: true,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("running");
		});

		test("tmux-backed running task still uses tmux cache (no regression)", () => {
			const task = createMockTask({
				id: "tmux-check",
				status: "running",
				terminal_backend: "tmux",
			});
			// Set tmux cache to alive
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: true,
				checkedAt: Date.now(),
			});
			// Persist cache says dead — should be ignored for tmux tasks
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(getPersistSocketPath(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("running");
		});

		test("legacy running task without terminal_backend falls back to tmux health", () => {
			const task = createMockTask({
				id: "legacy-tmux",
				status: "running",
				terminal_backend: undefined,
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("stopped");
		});

		test("persist health cache is used on second call within TTL", () => {
			const task = createMockTask({
				id: "persist-cached",
				status: "running",
				terminal_backend: "persist",
			});
			const persistCache = (
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache;
			persistCache.set(getPersistSocketPath(task), {
				alive: true,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();
			// First call uses cache
			expect(provider.getTasks()[0]?.status).toBe("running");

			// Reload again — cache entry should still be used (within 5s TTL)
			const sizeBeforeReload = persistCache.size;
			provider.reload();
			expect(provider.getTasks()[0]?.status).toBe("running");
			// Cache should not have grown (no duplicate entries)
			expect(persistCache.size).toBe(sizeBeforeReload);
		});

		test("uses task tmux_socket for tmux health checks instead of the default socket", () => {
			const socketPath = path.join(
				os.homedir(),
				".local",
				"state",
				"ghostty-launcher",
				"tmux",
				"test-task.sock",
			);
			const task = createMockTask({
				id: "tmux-dedicated-socket",
				status: "running",
				terminal_backend: "tmux",
				tmux_socket: socketPath,
			});
			execFileSyncMock.mockClear();
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("running");
			expect(execFileSyncMock).toHaveBeenCalledWith(
				"tmux",
				["-S", socketPath, "has-session", "-t", task.session_id],
				{ timeout: 500 },
			);
		});

		test("does not deduplicate tmux tasks with different window IDs in shared session", () => {
			// Real-world scenario: multiple agents share one tmux session but each
			// occupies a distinct window (@N).  They must all remain "running" — the
			// reconciler must not mark the older windows as stopped.
			const now = Date.now();
			const tmuxSocket = "/tmp/test-tmux.sock";
			// Use short started_at values (< stuckThreshold) so none are "looksStale".
			const window1 = createMockTask({
				id: "window-1",
				status: "running",
				session_id: "agent-command-central",
				terminal_backend: "tmux",
				tmux_window_id: "@1",
				tmux_socket: tmuxSocket,
				started_at: new Date(now - 5 * 60_000).toISOString(),
			});
			const window2 = createMockTask({
				id: "window-2",
				status: "running",
				session_id: "agent-command-central",
				terminal_backend: "tmux",
				tmux_window_id: "@2",
				tmux_socket: tmuxSocket,
				started_at: new Date(now - 3 * 60_000).toISOString(),
			});
			const window3 = createMockTask({
				id: "window-3",
				status: "running",
				session_id: "agent-command-central",
				terminal_backend: "tmux",
				tmux_window_id: "@3",
				tmux_socket: tmuxSocket,
				started_at: new Date(now - 1 * 60_000).toISOString(),
			});
			// Mark all windows as alive in the cache.
			const cacheType = provider as unknown as {
				_tmuxSessionHealthCache: Map<
					string,
					{ alive: boolean; checkedAt: number }
				>;
			};
			for (const w of [window1, window2, window3]) {
				cacheType._tmuxSessionHealthCache.set(
					`${tmuxSocket}::agent-command-central::${w.tmux_window_id}`,
					{ alive: true, checkedAt: Date.now() },
				);
			}
			provider.readRegistry = () =>
				createMockRegistry({
					[window1.id]: window1,
					[window2.id]: window2,
					[window3.id]: window3,
				});
			provider.reload();

			const displayStatuses = new Map(
				provider.getTasks().map((task) => [task.id, task.status]),
			);
			// All three windows are in independent windows — none should be stopped.
			expect(displayStatuses.get("window-1")).toBe("running");
			expect(displayStatuses.get("window-2")).toBe("running");
			expect(displayStatuses.get("window-3")).toBe("running");
		});

		test("marks tmux task as stale when its specific window is dead (shared session)", () => {
			// Even though the tmux SESSION is alive (other windows still running),
			// a task whose window has been killed should be detected as dead.
			const now = Date.now();
			const tmuxSocket = "/tmp/test-tmux2.sock";
			const deadWindow = createMockTask({
				id: "dead-window",
				status: "running",
				session_id: "agent-command-central",
				terminal_backend: "tmux",
				tmux_window_id: "@10",
				tmux_socket: tmuxSocket,
				started_at: new Date(now - 5 * 60 * 60_000).toISOString(),
			});
			// Window @10 is dead; the session is still alive (other windows exist).
			const cacheType = provider as unknown as {
				_tmuxSessionHealthCache: Map<
					string,
					{ alive: boolean; checkedAt: number }
				>;
			};
			cacheType._tmuxSessionHealthCache.set(
				`${tmuxSocket}::agent-command-central::@10`,
				{ alive: false, checkedAt: Date.now() },
			);
			provider.readRegistry = () =>
				createMockRegistry({ [deadWindow.id]: deadWindow });
			provider.reload();

			expect(provider.getTasks()[0]?.status).toBe("completed_stale");
		});

		test("does not collapse running tasks that only share session_id but have different runtime identity tuples", () => {
			const now = Date.now();
			const older = createMockTask({
				id: "stale-running",
				status: "running",
				session_id: "agent-shared",
				terminal_backend: "persist",
				persist_socket: "/tmp/agent-shared-old.sock",
				started_at: new Date(now - 10 * 60_000).toISOString(),
			});
			const newer = createMockTask({
				id: "fresh-running",
				status: "running",
				session_id: "agent-shared",
				terminal_backend: "persist",
				persist_socket: "/tmp/agent-shared-fresh.sock",
				started_at: new Date(now - 5 * 60_000).toISOString(),
			});
			const persistCache = (
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache;
			persistCache.set(getPersistSocketPath(older), {
				alive: true,
				checkedAt: Date.now(),
			});
			persistCache.set(getPersistSocketPath(newer), {
				alive: true,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () =>
				createMockRegistry({
					[older.id]: older,
					[newer.id]: newer,
				});
			provider.reload();

			const displayStatuses = new Map(
				provider.getTasks().map((task) => [task.id, task.status]),
			);
			expect(displayStatuses.get("stale-running")).toBe("running");
			expect(displayStatuses.get("fresh-running")).toBe("running");
		});

		test("marks only the older sibling stopped when runtime identity tuple matches exactly", () => {
			const now = Date.now();
			const sharedSocket = "/tmp/agent-shared.sock";
			const older = createMockTask({
				id: "stale-running",
				status: "running",
				session_id: "agent-shared",
				terminal_backend: "persist",
				persist_socket: sharedSocket,
				started_at: new Date(now - 10 * 60_000).toISOString(),
			});
			const newer = createMockTask({
				id: "fresh-running",
				status: "running",
				session_id: "agent-shared",
				terminal_backend: "persist",
				persist_socket: sharedSocket,
				started_at: new Date(now - 5 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(sharedSocket, {
				alive: true,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () =>
				createMockRegistry({
					[older.id]: older,
					[newer.id]: newer,
				});
			provider.reload();

			const displayStatuses = new Map(
				provider.getTasks().map((task) => [task.id, task.status]),
			);
			expect(displayStatuses.get("fresh-running")).toBe("running");
			expect(displayStatuses.get("stale-running")).toBe("stopped");
		});

		test("superseded sibling reason names the winning task id and runtime breadcrumbs", () => {
			const now = Date.now();
			const sharedSocket = "/tmp/agent-shared.sock";
			const older = createMockTask({
				id: "stale-running",
				status: "running",
				session_id: "agent-shared",
				terminal_backend: "persist",
				persist_socket: sharedSocket,
				started_at: new Date(now - 10 * 60_000).toISOString(),
			});
			const newer = createMockTask({
				id: "fresh-running",
				status: "running",
				session_id: "agent-shared",
				terminal_backend: "persist",
				persist_socket: sharedSocket,
				started_at: new Date(now - 5 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_persistSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._persistSessionHealthCache.set(sharedSocket, {
				alive: true,
				checkedAt: Date.now(),
			});
			provider.readRegistry = () =>
				createMockRegistry({
					[older.id]: older,
					[newer.id]: newer,
				});
			provider.reload();

			const staleTask = provider
				.getTasks()
				.find((task) => task.id === older.id);
			expect(staleTask?.status).toBe("stopped");
			expect(staleTask?.error_message).toContain("fresh-running");
			expect(staleTask?.error_message).toContain("persist");
			expect(staleTask?.error_message).toContain("socket=agent-shared.sock");
		});
	});

	describe("stuck agent detection", () => {
		test("isAgentStuck returns false for non-running agents", () => {
			const task = createMockTask({
				id: "stuck-not-running",
				status: "completed",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			expect(provider.isAgentStuck(task)).toBe(false);
		});

		test("isAgentStuck returns false for recent running agents", () => {
			const task = createMockTask({
				id: "stuck-recent-running",
				status: "running",
				started_at: new Date(Date.now() - 2 * 60_000).toISOString(),
			});
			expect(provider.isAgentStuck(task)).toBe(false);
		});

		test("isAgentStuck returns true for old running agents with no stream file", () => {
			const task = createMockTask({
				id: "stuck-old-no-stream",
				status: "running",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			expect(provider.isAgentStuck(task)).toBe(true);
		});

		test("isAgentStuck returns false when stream file has recent activity", () => {
			const task = createMockTask({
				id: "stuck-stream-recent",
				status: "running",
				agent_backend: "codex",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			const streamFile = `/tmp/codex-stream-${task.id}.jsonl`;
			try {
				fs.writeFileSync(streamFile, '{"type":"turn"}\n', "utf-8");
				const recent = new Date(Date.now() - 2 * 60_000);
				fs.utimesSync(streamFile, recent, recent);
				expect(provider.isAgentStuck(task)).toBe(false);
			} finally {
				if (fs.existsSync(streamFile)) fs.unlinkSync(streamFile);
			}
		});

		test("isAgentStuck returns true when stream file is old", () => {
			const task = createMockTask({
				id: "stuck-stream-old",
				status: "running",
				agent_backend: "codex",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			const streamFile = `/tmp/codex-stream-${task.id}.jsonl`;
			try {
				fs.writeFileSync(streamFile, '{"type":"turn"}\n', "utf-8");
				const old = new Date(Date.now() - 30 * 60_000);
				fs.utimesSync(streamFile, old, old);
				expect(provider.isAgentStuck(task)).toBe(true);
			} finally {
				if (fs.existsSync(streamFile)) fs.unlinkSync(streamFile);
			}
		});

		test("stuck running agents use warning icon and warning detail", () => {
			const task = createMockTask({
				id: "stuck-visual",
				status: "running",
				started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.getDiffSummary = () => null;
			provider.getGitInfo = () => null;
			provider.reload();

			const item = provider.getTreeItem({ type: "task", task });
			const icon = item.iconPath as { id: string; color?: { id: string } };
			expect(icon.id).toBe("warning");
			expect(icon.color?.id).toBe("charts.yellow");
			expect(item.description).toContain("(possibly stuck)");

			const root = provider.getChildren();
			const taskNode = getFirstTask(root);
			const children = provider.getChildren(taskNode);
			const warningDetail = children.find(
				(child) =>
					child.type === "detail" &&
					child.label.includes("No activity for 15 minutes"),
			);
			expect(warningDetail).toBeDefined();
			if (warningDetail?.type === "detail") {
				expect(warningDetail.label.startsWith("⚠️")).toBe(false);
			}
		});
	});

	describe("dirty-exit commit detection", () => {
		test("dead running task with commits shows as completed_dirty instead of stopped", () => {
			const task = createMockTask({
				id: "dirty-exit-with-commits",
				status: "running",
				terminal_backend: "tmux",
				start_commit: "abc123",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			// Mark tmux session as dead
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});

			// Mock git rev-list to return commit count > 0
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (
					cmd === "git" &&
					args?.includes("rev-list") &&
					args?.includes("--count")
				) {
					return "3\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			const tasks = provider.getTasks();
			expect(tasks[0]?.status).toBe("completed_dirty");
		});

		test("dead running task without commits still shows as stopped", () => {
			const task = createMockTask({
				id: "dirty-exit-no-commits",
				status: "running",
				terminal_backend: "tmux",
				start_commit: "abc123",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});

			// Mock git rev-list to return 0 commits
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (
					cmd === "git" &&
					args?.includes("rev-list") &&
					args?.includes("--count")
				) {
					return "0\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			const tasks = provider.getTasks();
			// Stale transition fires for dead tasks without commits
			expect(tasks[0]?.status).toBe("completed_stale");
		});

		test("dead running task without start_commit shows as completed_stale", () => {
			const task = createMockTask({
				id: "no-start-commit",
				status: "running",
				terminal_backend: "tmux",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});

			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			const tasks = provider.getTasks();
			// No start_commit → can't check commits → stale path takes over
			expect(tasks[0]?.status).toBe("completed_stale");
		});

		test("git failure falls through to completed_stale gracefully", () => {
			const task = createMockTask({
				id: "git-fail",
				status: "running",
				terminal_backend: "tmux",
				start_commit: "badref",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});

			// Mock git rev-list to throw
			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (
					cmd === "git" &&
					args?.includes("rev-list") &&
					args?.includes("--count")
				) {
					throw new Error("fatal: bad revision 'badref..HEAD'");
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			const tasks = provider.getTasks();
			// Git failure → hasCommitsSinceStart returns false → stale path
			expect(tasks[0]?.status).toBe("completed_stale");
		});

		test("stale transition skipped when task has commits (becomes completed_dirty instead)", () => {
			const task = createMockTask({
				id: "stale-with-commits",
				status: "running",
				terminal_backend: "tmux",
				start_commit: "abc123",
				started_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
			});
			(
				provider as unknown as {
					_tmuxSessionHealthCache: Map<
						string,
						{ alive: boolean; checkedAt: number }
					>;
				}
			)._tmuxSessionHealthCache.set(getTmuxHealthCacheKey(task), {
				alive: false,
				checkedAt: Date.now(),
			});

			execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
				const [cmd, args] = fnArgs as [string, string[] | undefined];
				if (
					cmd === "git" &&
					args?.includes("rev-list") &&
					args?.includes("--count")
				) {
					return "5\n";
				}
				return realChildProcess.execFileSync(
					cmd,
					args,
					fnArgs[2] as Parameters<typeof realChildProcess.execFileSync>[2],
				);
			});

			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			// Should NOT appear in stale tasks list
			expect(provider.getStaleLauncherTasks().map((t) => t.id)).not.toContain(
				"stale-with-commits",
			);

			// Should be completed_dirty, not completed_stale
			const tasks = provider.getTasks();
			expect(tasks[0]?.status).toBe("completed_dirty");
		});
	});
});
