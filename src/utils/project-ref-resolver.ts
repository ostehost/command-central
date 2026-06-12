/**
 * Work Registry project-ref resolution adapter.
 *
 * Active launcher lanes carry an embedded `project_ref` (the canonical Work
 * Registry resolution stamped at spawn time), so they never need this
 * adapter. It exists for legacy/explicit/fixture records that predate the
 * registry: those may still be attributable to a registered project by their
 * canonical project directory, project directory, execution directory,
 * exec cwd, or repo origin.
 *
 * Implementations MUST be synchronous and cheap — the adapter is consulted
 * from tree-render paths. Anything backed by a machine CLI (e.g.
 * `oc-project.mjs resolve`) must pre-compute or cache its table outside the
 * render path and serve lookups from memory.
 */

export interface ProjectRefResolutionInput {
	canonicalProjectDir?: string | null;
	projectDir?: string | null;
	executionDir?: string | null;
	execCwd?: string | null;
	repoOrigins?: readonly string[] | null;
}

export interface ResolvedProjectRef {
	id: string;
	displayName?: string | null;
}

export interface ProjectRefResolver {
	/**
	 * Resolve a task's Work Registry project identity, or `undefined` when the
	 * record cannot be attributed to a registered project. Unresolved records
	 * collapse into the UNREGISTERED PROJECTS bucket — resolvers must never
	 * fabricate an id from a path basename or worktree name.
	 */
	resolveProjectRef(
		input: ProjectRefResolutionInput,
	): ResolvedProjectRef | undefined;
}

/** Default adapter: resolves nothing. */
export const nullProjectRefResolver: ProjectRefResolver = {
	resolveProjectRef: () => undefined,
};

export interface StaticProjectRefEntry {
	id: string;
	displayName?: string | null;
	/** Directories (canonical checkout, worktrees, execution dirs) owned by this project. */
	directories?: readonly string[];
	/** Repo origins (e.g. "github.com/owner/repo") owned by this project. */
	repoOrigins?: readonly string[];
}

/**
 * Build a pure in-memory resolver from a static project table. Used by tests
 * and by callers that precompute the registry projection out-of-band.
 */
export function createStaticProjectRefResolver(
	entries: readonly StaticProjectRefEntry[],
): ProjectRefResolver {
	const byDirectory = new Map<string, ResolvedProjectRef>();
	const byOrigin = new Map<string, ResolvedProjectRef>();
	for (const entry of entries) {
		const resolved: ResolvedProjectRef = {
			id: entry.id,
			displayName: entry.displayName ?? null,
		};
		for (const directory of entry.directories ?? []) {
			const normalized = normalizeDirectory(directory);
			if (normalized) byDirectory.set(normalized, resolved);
		}
		for (const origin of entry.repoOrigins ?? []) {
			const normalized = normalizeRepoOrigin(origin);
			if (normalized) byOrigin.set(normalized, resolved);
		}
	}

	return {
		resolveProjectRef(input) {
			for (const directory of [
				input.canonicalProjectDir,
				input.projectDir,
				input.executionDir,
				input.execCwd,
			]) {
				const normalized = normalizeDirectory(directory);
				if (!normalized) continue;
				const resolved = byDirectory.get(normalized);
				if (resolved) return resolved;
			}
			for (const origin of input.repoOrigins ?? []) {
				const normalized = normalizeRepoOrigin(origin);
				if (!normalized) continue;
				const resolved = byOrigin.get(normalized);
				if (resolved) return resolved;
			}
			return undefined;
		},
	};
}

function normalizeDirectory(directory: string | null | undefined): string {
	const trimmed = directory?.trim() ?? "";
	if (!trimmed) return "";
	return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** Normalize "https://github.com/o/r.git", "git@github.com:o/r" → "github.com/o/r". */
function normalizeRepoOrigin(origin: string | null | undefined): string {
	const trimmed = origin?.trim().toLowerCase() ?? "";
	if (!trimmed) return "";
	return trimmed
		.replace(/^[a-z+]+:\/\//, "")
		.replace(/^git@([^:]+):/, "$1/")
		.replace(/^[^@]+@/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
}
