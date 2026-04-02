export interface ParsedTaskRegistry {
	version: number;
	tasks: Record<string, unknown>;
}

export const CLEARABLE_AGENT_TASK_STATUSES = new Set([
	"completed",
	"completed_dirty",
	"completed_stale",
	"failed",
	"stopped",
	"killed",
]);

export function parseTaskRegistry(raw: string): ParsedTaskRegistry {
	const parsed = JSON.parse(raw) as {
		version?: number;
		tasks?: Record<string, unknown>;
	};
	const version =
		parsed.version === 1 || parsed.version === 2 ? parsed.version : 2;
	const tasks =
		parsed.tasks && typeof parsed.tasks === "object" ? { ...parsed.tasks } : {};
	return { version, tasks };
}

export function serializeTaskRegistry(registry: ParsedTaskRegistry): string {
	return `${JSON.stringify(
		{
			version: registry.version,
			tasks: registry.tasks,
		},
		null,
		2,
	)}\n`;
}

export function removeTaskFromRegistryMap(
	tasks: Record<string, unknown>,
	taskId: string,
): boolean {
	if (taskId in tasks) {
		delete tasks[taskId];
		return true;
	}

	for (const [key, value] of Object.entries(tasks)) {
		const valueId =
			typeof value === "object" && value
				? (value as { id?: unknown }).id
				: undefined;
		if (
			typeof value === "object" &&
			value &&
			"id" in value &&
			valueId === taskId
		) {
			delete tasks[key];
			return true;
		}
	}

	return false;
}

export function countClearableAgentEntries(
	tasks: Record<string, unknown>,
): number {
	return Object.values(tasks).filter((entry) => {
		const status =
			typeof entry === "object" && entry
				? (entry as { status?: unknown }).status
				: undefined;
		return (
			typeof status === "string" && CLEARABLE_AGENT_TASK_STATUSES.has(status)
		);
	}).length;
}

export function clearCompletedAgentEntries(
	tasks: Record<string, unknown>,
): number {
	let removed = 0;
	for (const [key, value] of Object.entries(tasks)) {
		const status =
			typeof value === "object" && value
				? (value as { status?: unknown }).status
				: undefined;
		if (
			typeof status === "string" &&
			CLEARABLE_AGENT_TASK_STATUSES.has(status)
		) {
			delete tasks[key];
			removed += 1;
		}
	}
	return removed;
}
