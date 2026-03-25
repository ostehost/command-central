import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	type WorktreeInfo,
	WorktreeResolver,
} from "../../src/discovery/worktree-resolver.js";

type ExecFileLike = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

describe("WorktreeResolver", () => {
	let nowMs: number;
	const mockExec = mock(
		(_cmd: string, _args: readonly string[], _opts?: Record<string, unknown>) =>
			Promise.resolve({
				stdout: "",
				stderr: "",
			}) as Promise<{ stdout: string; stderr: string }>,
	);

	beforeEach(() => {
		nowMs = 1_700_000_000_000;
		mockExec.mockClear();
	});

	test("resolves main working tree info", async () => {
		mockExec.mockImplementation(
			(
				_cmd: string,
				args: readonly string[],
				opts?: Record<string, unknown>,
			) => {
				expect(opts?.["timeout"]).toBe(3_000);
				const key = args.slice(-2).join(" ");
				if (key === "rev-parse --show-toplevel") {
					return Promise.resolve({
						stdout: "/Users/test/repo\n",
						stderr: "",
					});
				}
				if (key === "rev-parse --git-common-dir") {
					return Promise.resolve({
						stdout: ".git\n",
						stderr: "",
					});
				}
				if (key === "branch --show-current") {
					return Promise.resolve({
						stdout: "main\n",
						stderr: "",
					});
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			},
		);

		const resolver = new WorktreeResolver(
			mockExec as unknown as ExecFileLike,
			() => nowMs,
		);
		const info = await resolver.resolveWorktree("/Users/test/repo/src");

		const expected: WorktreeInfo = {
			mainRepoDir: "/Users/test/repo",
			worktreeDir: "/Users/test/repo",
			branch: "main",
			isLinkedWorktree: false,
		};
		expect(info).toEqual(expected);
	});

	test("resolves linked worktree info", async () => {
		mockExec.mockImplementation((_cmd: string, args: readonly string[]) => {
			const key = args.slice(-2).join(" ");
			if (key === "rev-parse --show-toplevel") {
				return Promise.resolve({
					stdout: "/Users/test/repo-feature-auth\n",
					stderr: "",
				});
			}
			if (key === "rev-parse --git-common-dir") {
				return Promise.resolve({
					stdout: "/Users/test/repo/.git\n",
					stderr: "",
				});
			}
			if (key === "branch --show-current") {
				return Promise.resolve({
					stdout: "feature/auth\n",
					stderr: "",
				});
			}
			return Promise.resolve({ stdout: "", stderr: "" });
		});

		const resolver = new WorktreeResolver(
			mockExec as unknown as ExecFileLike,
			() => nowMs,
		);
		const info = await resolver.resolveWorktree(
			"/Users/test/repo-feature-auth",
		);

		expect(info).toEqual({
			mainRepoDir: "/Users/test/repo",
			worktreeDir: "/Users/test/repo-feature-auth",
			branch: "feature/auth",
			isLinkedWorktree: true,
		});
	});

	test("returns null for non-git directories", async () => {
		mockExec.mockImplementation(() =>
			Promise.reject(new Error("not a git repository")),
		);
		const resolver = new WorktreeResolver(
			mockExec as unknown as ExecFileLike,
			() => nowMs,
		);
		const info = await resolver.resolveWorktree("/tmp/not-a-repo");
		expect(info).toBeNull();
	});

	test("caches results for 30 seconds", async () => {
		mockExec.mockImplementation((_cmd: string, args: readonly string[]) => {
			const key = args.slice(-2).join(" ");
			if (key === "rev-parse --show-toplevel") {
				return Promise.resolve({
					stdout: "/Users/test/repo\n",
					stderr: "",
				});
			}
			if (key === "rev-parse --git-common-dir") {
				return Promise.resolve({
					stdout: ".git\n",
					stderr: "",
				});
			}
			if (key === "branch --show-current") {
				return Promise.resolve({
					stdout: "main\n",
					stderr: "",
				});
			}
			return Promise.resolve({ stdout: "", stderr: "" });
		});

		const resolver = new WorktreeResolver(
			mockExec as unknown as ExecFileLike,
			() => nowMs,
		);

		await resolver.resolveWorktree("/Users/test/repo");
		expect(mockExec).toHaveBeenCalledTimes(3);

		await resolver.resolveWorktree("/Users/test/repo");
		expect(mockExec).toHaveBeenCalledTimes(3);

		nowMs += 31_000;
		await resolver.resolveWorktree("/Users/test/repo");
		expect(mockExec).toHaveBeenCalledTimes(6);
	});
});
