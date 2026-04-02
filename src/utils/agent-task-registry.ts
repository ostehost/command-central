export interface ParsedTaskRegistry {
	version: number;
	tasks: Record<string, unknown>;
}

export const STALE_AGENT_STATUS_DESCRIPTION =
	"Stale — session ended without completion signal";

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
	const entryKey = findTaskRegistryEntryKey(tasks, taskId);
	if (!entryKey) return false;
	delete tasks[entryKey];
	return true;
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

export function markTaskFailedInRegistryMap(
	tasks: Record<string, unknown>,
	taskId: string,
	message = STALE_AGENT_STATUS_DESCRIPTION,
	timestamp = new Date().toISOString(),
): boolean {
	const entry = findTaskRegistryEntry(tasks, taskId);
	if (!entry) return false;

	entry["status"] = "failed";
	entry["error_message"] = message;
	entry["completed_at"] =
		typeof entry["completed_at"] === "string" &&
		(entry["completed_at"] as string).length > 0
			? entry["completed_at"]
			: timestamp;
	entry["updated_at"] = timestamp;
	return true;
}

export function markTasksFailedInRegistryMap(
	tasks: Record<string, unknown>,
	taskIds: Iterable<string>,
	message = STALE_AGENT_STATUS_DESCRIPTION,
	timestamp = new Date().toISOString(),
): number {
	let updated = 0;
	for (const taskId of taskIds) {
		if (markTaskFailedInRegistryMap(tasks, taskId, message, timestamp)) {
			updated += 1;
		}
	}
	return updated;
}

function findTaskRegistryEntryKey(
	tasks: Record<string, unknown>,
	taskId: string,
): string | null {
	if (taskId in tasks) {
		return taskId;
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
			return key;
		}
	}

	return null;
}

function findTaskRegistryEntry(
	tasks: Record<string, unknown>,
	taskId: string,
): Record<string, unknown> | null {
	const entryKey = findTaskRegistryEntryKey(tasks, taskId);
	if (!entryKey) return null;
	const entry = tasks[entryKey];
	return typeof entry === "object" && entry
		? (entry as Record<string, unknown>)
		: null;
}
