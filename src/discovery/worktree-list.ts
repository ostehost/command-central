export interface ListedWorktree {
	path: string;
	branch: string;
	head: string;
	isDetached: boolean;
}

function normalizeBranch(
	branchRef: string | null,
	isDetached: boolean,
): string {
	if (isDetached) return "detached";
	if (!branchRef) return "unknown";
	return branchRef.startsWith("refs/heads/")
		? branchRef.slice("refs/heads/".length)
		: branchRef;
}

export function parseWorktreeListPorcelain(output: string): ListedWorktree[] {
	const worktrees: ListedWorktree[] = [];
	const lines = output.split("\n");
	let currentPath: string | null = null;
	let currentHead = "";
	let currentBranch: string | null = null;
	let currentDetached = false;

	const pushCurrent = () => {
		if (!currentPath) return;
		worktrees.push({
			path: currentPath,
			head: currentHead,
			branch: normalizeBranch(currentBranch, currentDetached),
			isDetached: currentDetached,
		});
	};

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;

		if (line.startsWith("worktree ")) {
			pushCurrent();
			currentPath = line.slice("worktree ".length).trim();
			currentHead = "";
			currentBranch = null;
			currentDetached = false;
			continue;
		}

		if (line.startsWith("HEAD ")) {
			currentHead = line.slice("HEAD ".length).trim();
			continue;
		}

		if (line.startsWith("branch ")) {
			currentBranch = line.slice("branch ".length).trim();
			continue;
		}

		if (line === "detached") {
			currentDetached = true;
		}
	}

	pushCurrent();
	return worktrees;
}
