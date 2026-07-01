import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgentTask,
	createEmptyTaskRegistry,
	type TaskRegistry,
} from "../types/agent-task.js";
import type { LaneProjectionGcReceipt } from "../utils/review-queue-health.js";
import type { TaskRegistryIngest } from "../utils/tasks-file-resolver.js";
import { getTaskExecutionHostLabel } from "./agent-task-classification.js";
import {
	applyGcReceiptReconciliation,
	isRegistryBackedLaneTask,
	normalizeProjectionLanes,
	normalizeRegistryTasks,
	WORK_SYSTEM_LANES_PROJECTION_KIND,
} from "./agent-task-normalize.js";

/**
 * Reads and merges one or more `tasks.json`-shaped registry sources (plus the
 * transitional Work System lanes projection) into a single TaskRegistry.
 * Extracted from AgentStatusTreeProvider, which owns which files to read and
 * how to inject the GC receipt; this class owns parsing, per-source ingest
 * filtering, cross-file merge-key collision resolution, and the "log on
 * change, not every reload" dedup state for fallback/quarantine warnings.
 */
export class TaskRegistryReader {
	private lastLoggedRegistryState: string | null = null;
	private readonly lastWarnedRegistryFallback = new Map<string, string>();
	private lastLoggedLaneQuarantine: string | null = null;

	/** Force the next `readMerged` to re-log its summary line, e.g. when the configured source paths change. */
	resetLoggedState(): void {
		this.lastLoggedRegistryState = null;
	}

	readMerged(
		filePaths: string[],
		ingestModeFor: (filePath: string) => TaskRegistryIngest,
		readGcReceipt: () => LaneProjectionGcReceipt | null,
	): TaskRegistry {
		if (filePaths.length === 0) return createEmptyTaskRegistry();

		const merged: TaskRegistry = { version: 2, tasks: {} };
		for (const filePath of filePaths) {
			const registry = this.readFile(
				filePath,
				ingestModeFor(filePath),
				readGcReceipt,
			);
			for (const [key, task] of Object.entries(registry.tasks)) {
				// The Work System lanes projection is a read-model, never
				// authoritative truth: when a primary registry record and a
				// projection row share a task id, the primary record wins
				// regardless of file order — the projection row neither
				// displaces it nor duplicates it under a suffixed key.
				const preferred = task.id || key;
				const existing = merged.tasks[preferred];
				if (existing) {
					if (task.lane_projection && !existing.lane_projection) continue;
					if (!task.lane_projection && existing.lane_projection) {
						merged.tasks[preferred] =
							preferred === task.id ? task : { ...task, id: preferred };
						continue;
					}
				}
				const taskKey = this.getMergedTaskKey(
					key,
					task,
					filePath,
					merged.tasks,
				);
				merged.tasks[taskKey] =
					taskKey === task.id ? task : { ...task, id: taskKey };
			}
		}

		const taskCount = Object.keys(merged.tasks).length;
		const registryState = `${filePaths.join("::")}::${taskCount}`;
		if (this.lastLoggedRegistryState !== registryState) {
			console.info(
				`[Command Central] Agent Status loaded ${taskCount} launcher task${
					taskCount === 1 ? "" : "s"
				} from ${filePaths.length} task registr${
					filePaths.length === 1 ? "y" : "ies"
				}`,
			);
			this.lastLoggedRegistryState = registryState;
		}

		return merged;
	}

	private getMergedTaskKey(
		key: string,
		task: AgentTask,
		filePath: string,
		existingTasks: Record<string, AgentTask>,
	): string {
		const preferred = task.id || key;
		if (!existingTasks[preferred]) return preferred;

		const hostLabel = getTaskExecutionHostLabel(task)
			?.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		const sourceLabel =
			hostLabel ||
			path
				.basename(path.dirname(filePath))
				.replace(/[^A-Za-z0-9._-]+/g, "-")
				.replace(/^-+|-+$/g, "") ||
			"registry";
		let candidate = `${preferred}@${sourceLabel}`;
		let index = 2;
		while (existingTasks[candidate]) {
			candidate = `${preferred}@${sourceLabel}-${index}`;
			index += 1;
		}
		return candidate;
	}

	/**
	 * Emit a registry-fallback warning, but only when the reason for this
	 * source path differs from the last one logged. Repeated identical
	 * fallbacks (e.g. a registry that stays empty across many reloads) warn
	 * once instead of rattling the log on every reload. The full task history
	 * is never affected — this is purely about log output.
	 */
	private warnFallback(filePath: string, reason: string): void {
		if (this.lastWarnedRegistryFallback.get(filePath) === reason) return;
		this.lastWarnedRegistryFallback.set(filePath, reason);
		console.warn(
			`[Command Central] Falling back to an empty tasks registry for ${filePath}: ${reason}`,
		);
	}

	private readFile(
		filePath: string,
		ingest: TaskRegistryIngest,
		readGcReceipt: () => LaneProjectionGcReceipt | null,
	): TaskRegistry {
		let content = "";

		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (err) {
			if (
				err instanceof Error &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return createEmptyTaskRegistry();
			}

			this.warnFallback(
				filePath,
				err instanceof Error ? err.message : "Failed to read tasks.json",
			);
			return createEmptyTaskRegistry();
		}

		if (content.trim().length === 0) {
			this.warnFallback(filePath, "tasks.json is empty");
			return createEmptyTaskRegistry();
		}

		try {
			const parsed = JSON.parse(content) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				this.warnFallback(filePath, "tasks.json root is not a JSON object");
				return createEmptyTaskRegistry();
			}

			const parsedRegistry = parsed as Record<string, unknown>;
			const version = parsedRegistry["version"];

			// Transitional bridge compatibility: the Work System lanes
			// read-model/projection is self-describing via `kind`, so it can
			// never be confused with a legacy `{version, tasks}` registry (or
			// with the §6 drainable op-queue outbox, which uses a different
			// envelope at a different path). Rows still pass through the same
			// per-source ingest filter — the projection never widens what a
			// lane registry may admit.
			if (parsedRegistry["kind"] === WORK_SYSTEM_LANES_PROJECTION_KIND) {
				if (version !== 1) {
					this.warnFallback(
						filePath,
						`unsupported ${WORK_SYSTEM_LANES_PROJECTION_KIND} version: ${String(version)}`,
					);
					return createEmptyTaskRegistry();
				}
				const normalizedLanes = normalizeProjectionLanes(
					parsedRegistry["lanes"],
				);
				if (!normalizedLanes) {
					this.warnFallback(
						filePath,
						`${WORK_SYSTEM_LANES_PROJECTION_KIND} is missing a valid lanes collection`,
					);
					return createEmptyTaskRegistry();
				}
				return {
					version: 2,
					tasks: this.applyIngestFilter(
						filePath,
						applyGcReceiptReconciliation(normalizedLanes, readGcReceipt()),
						ingest,
					),
				};
			}

			const normalizedTasks = normalizeRegistryTasks(parsedRegistry["tasks"]);
			if ((version === 1 || version === 2) && normalizedTasks) {
				return {
					version: 2,
					tasks: this.applyIngestFilter(filePath, normalizedTasks, ingest),
				};
			}

			this.warnFallback(
				filePath,
				version !== 1 && version !== 2
					? `unsupported tasks.json version: ${String(version)}`
					: "tasks.json is missing a valid tasks collection",
			);
			return createEmptyTaskRegistry();
		} catch (err) {
			this.warnFallback(
				filePath,
				err instanceof Error ? err.message : "Failed to parse tasks.json",
			);
			return createEmptyTaskRegistry();
		}
	}

	/**
	 * Lane registry sources only admit registry-backed LaneRef records;
	 * launcher-era rows without a `project_ref` stay quarantined even though
	 * they share the file. The quarantined count is logged so hidden rows are
	 * diagnosable without flipping the legacy escape hatch.
	 */
	private applyIngestFilter(
		filePath: string,
		tasks: Record<string, AgentTask>,
		ingest: TaskRegistryIngest,
	): Record<string, AgentTask> {
		if (ingest !== "lane-records-only") return tasks;

		const admitted: Record<string, AgentTask> = {};
		let quarantined = 0;
		for (const [key, task] of Object.entries(tasks)) {
			if (isRegistryBackedLaneTask(task)) {
				admitted[key] = task;
			} else {
				quarantined += 1;
			}
		}

		const quarantineState = `${filePath}::${quarantined}`;
		if (quarantined > 0 && this.lastLoggedLaneQuarantine !== quarantineState) {
			console.info(
				`[Command Central] Lane registry ${filePath}: quarantined ${quarantined} record${
					quarantined === 1 ? "" : "s"
				} without project_ref (legacy launcher rows stay hidden)`,
			);
			this.lastLoggedLaneQuarantine = quarantineState;
		}

		return admitted;
	}
}
