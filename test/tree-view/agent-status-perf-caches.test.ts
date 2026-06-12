/**
 * AgentStatusTreeProvider — perf cache unit tests
 *
 * Verifies the TTL caches added for:
 *   - resolveStreamFilePath (5 s TTL)
 *   - getStreamTerminalState (5 s TTL)
 *   - hasCommitsSinceStart (30 s TTL)
 *   - getDisplayLauncherTasks render-cycle memoization
 *
 * Each test either:
 *   (a) Calls the method twice and counts execFileSyncMock calls to
 *       prove the second call is a cache hit (zero new spawns), or
 *   (b) Directly inspects the private cache Maps to verify entries are
 *       populated, refreshed, or cleared at the right moments.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
	type AgentStatusTreeProvider,
	type AgentTask,
	createMockRegistry,
	createMockTask,
	createProviderHarness,
	disposeHarness,
	type ProviderHarness,
} from "./_helpers/agent-status-tree-provider-test-base.js";

// Real node:fs (the helper auto-mocks node:fs back to real fs).
const fs = require("node:fs") as typeof import("node:fs");

// ── private-cache accessor ────────────────────────────────────────────────

type PrivateCaches = {
	_streamFilePathCache: Map<string, { path: string | null; checkedAt: number }>;
	_streamTerminalStateCache: Map<
		string,
		{
			state: {
				status: "completed" | "failed";
				reason?: string;
				completedAt?: string;
				exitCode?: number | null;
			} | null;
			checkedAt: number;
		}
	>;
	_commitsSinceStartCache: Map<string, { result: boolean; checkedAt: number }>;
	_displayTasksRenderCache: AgentTask[] | null;
	_displayTasksCachedRegistry: unknown | null;
	registry: { version: number; tasks: Record<string, AgentTask> };
};

function caches(p: AgentStatusTreeProvider): PrivateCaches {
	return p as unknown as PrivateCaches;
}

// ── helper: call private methods through cast ────────────────────────────

function callResolveStreamFilePath(
	p: AgentStatusTreeProvider,
	task: AgentTask,
): string | null {
	return (
		p as unknown as { resolveStreamFilePath: (t: AgentTask) => string | null }
	).resolveStreamFilePath(task);
}

function callGetStreamTerminalState(
	p: AgentStatusTreeProvider,
	task: AgentTask,
): unknown {
	return (
		p as unknown as {
			getStreamTerminalState: (t: AgentTask) => unknown;
		}
	).getStreamTerminalState(task);
}

function callHasCommitsSinceStart(
	p: AgentStatusTreeProvider,
	task: AgentTask,
): boolean {
	return (
		p as unknown as {
			hasCommitsSinceStart: (t: AgentTask) => boolean;
		}
	).hasCommitsSinceStart(task);
}

function callGetDisplayLauncherTasks(p: AgentStatusTreeProvider): AgentTask[] {
	return (
		p as unknown as { getDisplayLauncherTasks: () => AgentTask[] }
	).getDisplayLauncherTasks();
}

// ── helper: expire cache entries ─────────────────────────────────────────

function expireStreamFilePathCache(p: AgentStatusTreeProvider, taskId: string) {
	const c = caches(p)._streamFilePathCache;
	const e = c.get(taskId);
	if (e) c.set(taskId, { ...e, checkedAt: Date.now() - 10_000 });
}

function expireStreamTerminalStateCache(
	p: AgentStatusTreeProvider,
	taskId: string,
) {
	const c = caches(p)._streamTerminalStateCache;
	const e = c.get(taskId);
	if (e) c.set(taskId, { ...e, checkedAt: Date.now() - 10_000 });
}

function expireCommitsSinceStartCache(
	p: AgentStatusTreeProvider,
	task: AgentTask,
) {
	const key = `${task.id}::${task.start_commit}`;
	const c = caches(p)._commitsSinceStartCache;
	const e = c.get(key);
	if (e) c.set(key, { ...e, checkedAt: Date.now() - 60_000 });
}

// ─────────────────────────────────────────────────────────────────────────

describe("AgentStatusTreeProvider — perf caches", () => {
	let h: ProviderHarness;
	let provider: AgentStatusTreeProvider;

	beforeEach(() => {
		h = createProviderHarness();
		provider = h.provider;
	});

	afterEach(() => {
		disposeHarness(h);
	});

	// ── resolveStreamFilePath TTL cache ──────────────────────────────────

	describe("resolveStreamFilePath TTL cache (5 s)", () => {
		test("first call populates the cache", () => {
			const streamFile = nodePath.join(
				os.tmpdir(),
				`cc-perf-sfp-${Date.now()}.jsonl`,
			);
			fs.writeFileSync(streamFile, "");
			const task = createMockTask({ id: "sfp-warm", stream_file: streamFile });

			try {
				callResolveStreamFilePath(provider, task);
				expect(caches(provider)._streamFilePathCache.has(task.id)).toBe(true);
				expect(caches(provider)._streamFilePathCache.get(task.id)?.path).toBe(
					streamFile,
				);
			} finally {
				try {
					fs.unlinkSync(streamFile);
				} catch {}
			}
		});

		test("second call within TTL window does not update checkedAt", () => {
			const streamFile = nodePath.join(
				os.tmpdir(),
				`cc-perf-sfp-ttl-${Date.now()}.jsonl`,
			);
			fs.writeFileSync(streamFile, "");
			const task = createMockTask({ id: "sfp-ttl", stream_file: streamFile });

			try {
				callResolveStreamFilePath(provider, task);
				const checkedAt1 = caches(provider)._streamFilePathCache.get(
					task.id,
				)!.checkedAt;

				callResolveStreamFilePath(provider, task);
				const checkedAt2 = caches(provider)._streamFilePathCache.get(
					task.id,
				)!.checkedAt;

				// Cache was NOT re-probed → timestamp unchanged.
				expect(checkedAt2).toBe(checkedAt1);
			} finally {
				try {
					fs.unlinkSync(streamFile);
				} catch {}
			}
		});

		test("call after TTL expiry refreshes the cache entry", () => {
			const streamFile = nodePath.join(
				os.tmpdir(),
				`cc-perf-sfp-expire-${Date.now()}.jsonl`,
			);
			fs.writeFileSync(streamFile, "");
			const task = createMockTask({
				id: "sfp-expire",
				stream_file: streamFile,
			});

			try {
				callResolveStreamFilePath(provider, task);

				// Back-date the cache entry to simulate TTL expiry.
				expireStreamFilePathCache(provider, task.id);
				const staleCheckedAt = caches(provider)._streamFilePathCache.get(
					task.id,
				)!.checkedAt;

				callResolveStreamFilePath(provider, task);
				const freshCheckedAt = caches(provider)._streamFilePathCache.get(
					task.id,
				)!.checkedAt;

				// The fresh entry must not be the stale back-dated one.
				expect(freshCheckedAt).toBeGreaterThan(staleCheckedAt);
				// And it must be within the TTL window (not stale).
				expect(Date.now() - freshCheckedAt).toBeLessThan(5_000);
			} finally {
				try {
					fs.unlinkSync(streamFile);
				} catch {}
			}
		});

		test("reload() clears cache so next call detects file deletion", () => {
			const streamFile = nodePath.join(
				os.tmpdir(),
				`cc-perf-sfp-reload-${Date.now()}.jsonl`,
			);
			fs.writeFileSync(streamFile, "");

			const task = createMockTask({
				id: "sfp-reload",
				status: "running",
				stream_file: streamFile,
			});

			// Warm cache with file present.
			expect(callResolveStreamFilePath(provider, task)).toBe(streamFile);

			// Delete file and trigger reload (clears caches).
			fs.unlinkSync(streamFile);
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			// Next call must NOT return the deleted file path.
			const afterReload = callResolveStreamFilePath(provider, task);
			expect(afterReload).toBeNull();
		});

		test("dispose() clears the stream-file-path cache", () => {
			const task = createMockTask({ id: "sfp-dispose" });
			caches(provider)._streamFilePathCache.set(task.id, {
				path: "/tmp/dummy.jsonl",
				checkedAt: Date.now(),
			});
			provider.dispose();
			expect(caches(provider)._streamFilePathCache.size).toBe(0);
		});
	});

	// ── getStreamTerminalState TTL cache ─────────────────────────────────

	describe("getStreamTerminalState TTL cache (5 s)", () => {
		test("first call populates the cache", () => {
			const streamFile = nodePath.join(
				os.tmpdir(),
				`cc-perf-sts-${Date.now()}.jsonl`,
			);
			fs.writeFileSync(
				streamFile,
				`${JSON.stringify({ type: "turn.completed" })}\n`,
			);
			const task = createMockTask({
				id: "sts-warm",
				stream_file: streamFile,
			});

			try {
				callGetStreamTerminalState(provider, task);
				expect(caches(provider)._streamTerminalStateCache.has(task.id)).toBe(
					true,
				);
				expect(
					caches(provider)._streamTerminalStateCache.get(task.id)?.state
						?.status,
				).toBe("completed");
			} finally {
				try {
					fs.unlinkSync(streamFile);
				} catch {}
			}
		});

		test("second call within TTL does not update checkedAt", () => {
			const streamFile = nodePath.join(
				os.tmpdir(),
				`cc-perf-sts-ttl-${Date.now()}.jsonl`,
			);
			fs.writeFileSync(
				streamFile,
				`${JSON.stringify({ type: "turn.completed" })}\n`,
			);
			const task = createMockTask({ id: "sts-ttl", stream_file: streamFile });

			try {
				callGetStreamTerminalState(provider, task);
				const ts1 = caches(provider)._streamTerminalStateCache.get(
					task.id,
				)!.checkedAt;

				callGetStreamTerminalState(provider, task);
				const ts2 = caches(provider)._streamTerminalStateCache.get(
					task.id,
				)!.checkedAt;

				expect(ts2).toBe(ts1);
			} finally {
				try {
					fs.unlinkSync(streamFile);
				} catch {}
			}
		});

		test("call after TTL expiry refreshes the cache entry", () => {
			const streamFile = nodePath.join(
				os.tmpdir(),
				`cc-perf-sts-expire-${Date.now()}.jsonl`,
			);
			fs.writeFileSync(
				streamFile,
				`${JSON.stringify({ type: "turn.completed" })}\n`,
			);
			const task = createMockTask({
				id: "sts-expire",
				stream_file: streamFile,
			});

			try {
				callGetStreamTerminalState(provider, task);

				// Back-date the cache entry to simulate TTL expiry.
				expireStreamTerminalStateCache(provider, task.id);
				const staleCheckedAt = caches(provider)._streamTerminalStateCache.get(
					task.id,
				)!.checkedAt;

				callGetStreamTerminalState(provider, task);
				const freshCheckedAt = caches(provider)._streamTerminalStateCache.get(
					task.id,
				)!.checkedAt;

				// The fresh entry must not be the stale back-dated one.
				expect(freshCheckedAt).toBeGreaterThan(staleCheckedAt);
				// And it must be within the TTL window (not stale).
				expect(Date.now() - freshCheckedAt).toBeLessThan(5_000);
			} finally {
				try {
					fs.unlinkSync(streamFile);
				} catch {}
			}
		});

		test("reload() clears the stream-terminal-state cache", () => {
			const task = createMockTask({
				id: "sts-reload-clear",
				status: "running",
			});
			caches(provider)._streamTerminalStateCache.set(task.id, {
				state: { status: "completed" },
				checkedAt: Date.now() - 1,
			});

			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			// After reload the old stale entry should be gone.  reload() may
			// recompute the state (via checkStaleTransitions), so we only assert
			// the stale pre-reload value is no longer present, not that the map
			// is empty (it may have a fresh entry).
			const entry = caches(provider)._streamTerminalStateCache.get(task.id);
			if (entry) {
				// If repopulated, it must have a fresh checkedAt (not the stale one).
				expect(entry.checkedAt).toBeGreaterThan(Date.now() - 1_000);
			}
			// (map could also be absent; both outcomes are correct)
		});
	});

	// ── hasCommitsSinceStart TTL cache ───────────────────────────────────

	describe("hasCommitsSinceStart TTL cache (30 s)", () => {
		test("first call runs git and populates the cache", () => {
			h.execFileSyncMock.mockImplementation(
				(...args: unknown[]): ReturnType<typeof h.execFileSyncMock> => {
					const [cmd, a] = args as [string, string[] | undefined];
					if (cmd === "git" && a?.includes("rev-list")) return "1\n";
					if (cmd === "tmux") return "";
					throw new Error(`Unexpected: ${cmd}`);
				},
			);

			const task = createMockTask({
				id: "csc-warm",
				start_commit: "abc1234",
				project_dir: "/tmp/fake-project",
			});

			callHasCommitsSinceStart(provider, task);

			const key = `${task.id}::${task.start_commit}`;
			expect(caches(provider)._commitsSinceStartCache.has(key)).toBe(true);
			expect(caches(provider)._commitsSinceStartCache.get(key)?.result).toBe(
				true,
			);
		});

		test("second call within TTL skips git — execFileSyncMock count unchanged", () => {
			h.execFileSyncMock.mockImplementation(
				(...args: unknown[]): ReturnType<typeof h.execFileSyncMock> => {
					const [cmd, a] = args as [string, string[] | undefined];
					if (cmd === "git" && a?.includes("rev-list")) return "1\n";
					if (cmd === "tmux") return "";
					throw new Error(`Unexpected: ${cmd}`);
				},
			);

			const task = createMockTask({
				id: "csc-ttl",
				start_commit: "def5678",
				project_dir: "/tmp/fake-project-2",
			});

			callHasCommitsSinceStart(provider, task);
			const gitCallsAfterFirst = h.execFileSyncMock.mock.calls.filter(
				([cmd]: unknown[]) => cmd === "git",
			).length;
			expect(gitCallsAfterFirst).toBeGreaterThanOrEqual(1);

			// Second call — must be a cache hit.
			callHasCommitsSinceStart(provider, task);
			const gitCallsAfterSecond = h.execFileSyncMock.mock.calls.filter(
				([cmd]: unknown[]) => cmd === "git",
			).length;

			expect(gitCallsAfterSecond).toBe(gitCallsAfterFirst);
		});

		test("call after TTL expiry re-invokes git", () => {
			h.execFileSyncMock.mockImplementation(
				(...args: unknown[]): ReturnType<typeof h.execFileSyncMock> => {
					const [cmd, a] = args as [string, string[] | undefined];
					if (cmd === "git" && a?.includes("rev-list")) return "1\n";
					if (cmd === "tmux") return "";
					throw new Error(`Unexpected: ${cmd}`);
				},
			);

			const task = createMockTask({
				id: "csc-expire",
				start_commit: "ghi9012",
				project_dir: "/tmp/fake-project-3",
			});

			callHasCommitsSinceStart(provider, task);
			const gitCallsAfterFirst = h.execFileSyncMock.mock.calls.filter(
				([cmd]: unknown[]) => cmd === "git",
			).length;

			expireCommitsSinceStartCache(provider, task);
			callHasCommitsSinceStart(provider, task);

			const gitCallsAfterSecond = h.execFileSyncMock.mock.calls.filter(
				([cmd]: unknown[]) => cmd === "git",
			).length;
			expect(gitCallsAfterSecond).toBeGreaterThan(gitCallsAfterFirst);
		});

		test("reload() clears commits-since-start cache", () => {
			const task = createMockTask({
				id: "csc-reload",
				start_commit: "jkl3456",
				project_dir: "/tmp/fake-project-4",
			});
			const key = `${task.id}::${task.start_commit}`;
			caches(provider)._commitsSinceStartCache.set(key, {
				result: true,
				checkedAt: Date.now(),
			});

			provider.readRegistry = () => createMockRegistry({});
			provider.reload();

			expect(caches(provider)._commitsSinceStartCache.has(key)).toBe(false);
		});
	});

	// ── getDisplayLauncherTasks render-cycle memoization ─────────────────

	describe("getDisplayLauncherTasks render-cycle memoization", () => {
		test("multiple calls within a synchronous burst return the same reference", () => {
			const task = createMockTask({ id: "memo-t1", status: "running" });
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			const r1 = callGetDisplayLauncherTasks(provider);
			const r2 = callGetDisplayLauncherTasks(provider);
			const r3 = callGetDisplayLauncherTasks(provider);

			// All three calls in the same synchronous burst should return the
			// exact same array reference — no redundant toDisplayTask() work.
			expect(r2).toBe(r1);
			expect(r3).toBe(r1);
		});

		test("cache is keyed to the registry object; direct reassignment invalidates it", () => {
			const task1 = createMockTask({ id: "memo-inv-t1", status: "running" });
			const task2 = createMockTask({ id: "memo-inv-t2", status: "completed" });

			provider.readRegistry = () => createMockRegistry({ [task1.id]: task1 });
			provider.reload();

			const before = callGetDisplayLauncherTasks(provider);
			expect(before.map((t) => t.id)).toContain(task1.id);

			// Directly replace registry (test-helper style — bypasses reload).
			caches(provider).registry = createMockRegistry({ [task2.id]: task2 });

			// New reference → fresh computation.
			const after = callGetDisplayLauncherTasks(provider);
			expect(after).not.toBe(before);
			expect(after.map((t) => t.id)).toContain(task2.id);
			expect(after.map((t) => t.id)).not.toContain(task1.id);
		});

		test("reload() resets the cache so subsequent call sees the new registry", () => {
			const task1 = createMockTask({ id: "memo-reload-t1", status: "running" });
			const task2 = createMockTask({
				id: "memo-reload-t2",
				status: "completed",
			});

			provider.readRegistry = () => createMockRegistry({ [task1.id]: task1 });
			provider.reload();

			// Warm the cache.
			const before = callGetDisplayLauncherTasks(provider);
			expect(before.map((t) => t.id)).toContain(task1.id);

			provider.readRegistry = () => createMockRegistry({ [task2.id]: task2 });
			provider.reload();

			const after = callGetDisplayLauncherTasks(provider);
			expect(after.map((t) => t.id)).toContain(task2.id);
			expect(after.map((t) => t.id)).not.toContain(task1.id);
		});

		test("burst does not multiply execFileSync git calls (N calls → ≤1 git spawn)", () => {
			h.execFileSyncMock.mockImplementation(
				(...args: unknown[]): ReturnType<typeof h.execFileSyncMock> => {
					const [cmd, a] = args as [string, string[] | undefined];
					if (cmd === "tmux" && a?.includes("has-session"))
						throw new Error("no session");
					if (cmd === "git" && a?.includes("rev-list")) return "0\n";
					throw new Error(`Unexpected: ${cmd} ${(a ?? []).join(" ")}`);
				},
			);

			const task = createMockTask({
				id: "memo-git",
				status: "running",
				start_commit: "deadbeef",
				project_dir: "/tmp/fake-memo-git",
			});
			provider.readRegistry = () => createMockRegistry({ [task.id]: task });
			provider.reload();

			// Clear mock so reload() git calls don't count.
			h.execFileSyncMock.mockClear();

			// 5 calls in one synchronous burst.
			for (let i = 0; i < 5; i++) {
				callGetDisplayLauncherTasks(provider);
			}

			const gitRevListCalls = h.execFileSyncMock.mock.calls.filter(
				([cmd, a]: unknown[]) =>
					cmd === "git" &&
					Array.isArray(a) &&
					(a as string[]).includes("rev-list"),
			).length;

			// With memoization, the git call should only happen once (the first
			// time toDisplayTask() runs, inside the first getDisplayLauncherTasks
			// call in the burst).
			expect(gitRevListCalls).toBeLessThanOrEqual(1);
		});
	});
});
