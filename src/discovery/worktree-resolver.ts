import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const GIT_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 30_000;

type ExecFileFn = (
	file: string,
	args: string[],
	options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFileAsync: ExecFileFn = async (file, args, options) => {
	const execFileAsync = promisify(execFile);
	const { stdout, stderr } = await execFileAsync(file, args, {
		...options,
		encoding: "utf-8",
	});
	return {
		stdout: String(stdout),
		stderr: String(stderr),
	};
};

export interface WorktreeInfo {
	/** The root of the main repository (git commondir) */
	mainRepoDir: string;
	/** The worktree-specific directory (may equal mainRepoDir if not a worktree) */
	worktreeDir: string;
	/** The branch checked out in this worktree */
	branch: string;
	/** Whether this is a linked worktree (true) or the main working tree (false) */
	isLinkedWorktree: boolean;
}

function isPathInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

type CacheEntry = {
	expiresAt: number;
	value: WorktreeInfo | null;
};

export class WorktreeResolver {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly execFileAsync: ExecFileFn;
	private readonly now: () => number;

	constructor(execFileFn?: ExecFileFn, now?: () => number) {
		this.execFileAsync = execFileFn ?? defaultExecFileAsync;
		this.now = now ?? (() => Date.now());
	}

	async resolveWorktree(dir: string): Promise<WorktreeInfo | null> {
		const cacheKey = path.resolve(dir);
		const cached = this.cache.get(cacheKey);
		const now = this.now();
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const value = await this.compute(cacheKey);
		this.cache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
		return value;
	}

	clearCache(): void {
		this.cache.clear();
	}

	private async runGit(dir: string, args: string[]): Promise<string | null> {
		try {
			const { stdout } = await this.execFileAsync("git", ["-C", dir, ...args], {
				timeout: GIT_TIMEOUT_MS,
			});
			return stdout.trim();
		} catch {
			return null;
		}
	}

	private async compute(dir: string): Promise<WorktreeInfo | null> {
		const worktreeTopLevel = await this.runGit(dir, [
			"rev-parse",
			"--show-toplevel",
		]);
		if (!worktreeTopLevel) return null;

		const gitCommonDir = await this.runGit(dir, [
			"rev-parse",
			"--git-common-dir",
		]);
		if (!gitCommonDir) return null;

		const branchRaw = await this.runGit(dir, ["branch", "--show-current"]);
		if (branchRaw === null) return null;

		const worktreeDir = path.resolve(dir, worktreeTopLevel);
		const commonDir = path.resolve(worktreeDir, gitCommonDir);
		const isLinkedWorktree = !isPathInside(worktreeDir, commonDir);
		const mainRepoDir = path.dirname(commonDir);

		return {
			mainRepoDir,
			worktreeDir,
			branch: branchRaw || "HEAD",
			isLinkedWorktree,
		};
	}
}

const defaultResolver = new WorktreeResolver();

export async function resolveWorktree(
	dir: string,
): Promise<WorktreeInfo | null> {
	return defaultResolver.resolveWorktree(dir);
}
