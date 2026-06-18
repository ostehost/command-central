/**
 * Pure Symphony projection + run-group presentation helpers.
 *
 * These functions partition Codex runs into the Symphony run groups (running /
 * retry-queued / released), read the runtime snapshot, and format the group
 * labels, counts, and descriptions shown in the Symphony tree. They were
 * extracted from AgentStatusTreeProvider, where they were stateless private
 * methods that only called one another (and the codex-run-format helpers).
 * No provider state is touched.
 */

import * as vscode from "vscode";
import type {
	CodexRunView,
	SymphonyRetryEntryView,
	SymphonyRunningEntryView,
	SymphonyRuntimeSnapshotView,
} from "../types/codex-run-types.js";
import type { TaskFlow } from "../types/taskflow-types.js";
import type {
	SymphonyRunGroupKind,
	SymphonyRunGroupNode,
	SymphonySnapshotEntryNode,
} from "./agent-status-tree-nodes.js";

export function getSymphonyRunningSessionRuns(
	runs: CodexRunView[],
): CodexRunView[] {
	return runs.filter(
		(run) =>
			run.status === "running" &&
			!isSymphonyRetryQueuedRun(run) &&
			!isSymphonyReleasedRun(run),
	);
}

export function getSymphonyRetryQueuedRuns(
	runs: CodexRunView[],
): CodexRunView[] {
	return runs.filter((run) => isSymphonyRetryQueuedRun(run));
}

export function getSymphonyReleasedRuns(runs: CodexRunView[]): CodexRunView[] {
	return runs.filter((run) => isSymphonyReleasedRun(run));
}

export function isSymphonyRetryQueuedRun(run: CodexRunView): boolean {
	return (
		normalizeSymphonySourceStatus(run.sourceStatus) === "retryqueued" ||
		run.retryAttempt != null ||
		run.retryDueAt != null ||
		Boolean(run.retryError)
	);
}

export function isSymphonyReleasedRun(run: CodexRunView): boolean {
	return normalizeSymphonySourceStatus(run.sourceStatus) === "released";
}

export function normalizeSymphonySourceStatus(
	value: string | undefined,
): string {
	return value?.replace(/[\s_-]+/g, "").toLowerCase() ?? "";
}

export function getSymphonyRuntimeSnapshot(
	runs: CodexRunView[],
): SymphonyRuntimeSnapshotView | undefined {
	return runs.find((run) => run.symphonyRuntimeSnapshot)
		?.symphonyRuntimeSnapshot;
}

export function formatSymphonyRuntimeSnapshotStatus(
	snapshot: SymphonyRuntimeSnapshotView,
): string {
	if (snapshot.error) {
		return `${snapshot.error.code}: ${snapshot.error.message}`;
	}
	return snapshot.status;
}

export function formatSymphonySnapshotValue(value: unknown): string {
	if (value == null) return "Not provided by lifecycle owner";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function getSymphonyRunGroupCount(node: SymphonyRunGroupNode): number {
	if (node.kind === "running" && node.snapshot?.running) {
		return node.snapshot.running.length;
	}
	if (node.kind === "retryQueued" && node.snapshot?.retrying) {
		return node.snapshot.retrying.length;
	}
	return node.runs.length;
}

export function getSymphonyRunGroupSnapshotEntries(
	node: SymphonyRunGroupNode,
): SymphonySnapshotEntryNode[] {
	if (node.kind === "running" && node.snapshot?.running) {
		return node.snapshot.running.map((entry, index) => ({
			type: "symphonySnapshotEntry",
			kind: "running",
			entry,
			index,
			snapshot: node.snapshot as SymphonyRuntimeSnapshotView,
		}));
	}
	if (node.kind === "retryQueued" && node.snapshot?.retrying) {
		return node.snapshot.retrying.map((entry, index) => ({
			type: "symphonySnapshotEntry",
			kind: "retryQueued",
			entry,
			index,
			snapshot: node.snapshot as SymphonyRuntimeSnapshotView,
		}));
	}
	return [];
}

export function getSymphonySnapshotEntryIssue(
	entry: SymphonyRunningEntryView | SymphonyRetryEntryView,
): string | undefined {
	const id = entry.issueIdentifier ?? entry.issueId;
	return [id, entry.issueState].filter(Boolean).join(" · ") || undefined;
}

export function formatSymphonyRootDescription(
	runs: CodexRunView[],
	flows: TaskFlow[],
): string {
	const running = getSymphonyRunningSessionRuns(runs).length;
	const retryQueued = getSymphonyRetryQueuedRuns(runs).length;
	const runLabel =
		runs.length === 0
			? "no projected runs"
			: flows.length === 0
				? `${runs.length} standalone ${runs.length === 1 ? "run attempt" : "run attempts"}`
				: `${runs.length} ${runs.length === 1 ? "run attempt" : "run attempts"}`;
	const parts = [
		runLabel,
		flows.length > 0
			? `${flows.length} ${flows.length === 1 ? "workstream" : "workstreams"}`
			: null,
		running > 0 ? `${running} running` : null,
		retryQueued > 0 ? `${retryQueued} RetryQueued` : null,
	].filter((part): part is string => part !== null);
	return parts.join(" · ");
}

export function formatSymphonyDashboardDescription(
	runs: CodexRunView[],
): string {
	const snapshot = getSymphonyRuntimeSnapshot(runs);
	const running =
		snapshot?.counts?.running ?? getSymphonyRunningSessionRuns(runs).length;
	const retryQueued =
		snapshot?.counts?.retrying ?? getSymphonyRetryQueuedRuns(runs).length;
	const rateLimited = runs.filter((run) => run.rateLimitSummary).length;
	const parts = [
		running > 0 ? `${running} running` : null,
		retryQueued > 0 ? `${retryQueued} RetryQueued` : null,
		snapshot?.rateLimits !== undefined
			? "1 rate-limit snapshot"
			: rateLimited > 0
				? `${rateLimited} rate-limit snapshots`
				: null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : "read-only status surface";
}

export function getSymphonyRunGroupLabel(kind: SymphonyRunGroupKind): string {
	switch (kind) {
		case "running":
			return "Running Sessions";
		case "retryQueued":
			return "Retry Queue";
		case "released":
			return "Released";
	}
}

export function getSymphonyRunGroupSpecStatus(
	kind: SymphonyRunGroupKind,
): string {
	switch (kind) {
		case "running":
			return "Running";
		case "retryQueued":
			return "RetryQueued";
		case "released":
			return "Released";
	}
}

export function getSymphonyRunGroupEmptyLabel(
	kind: SymphonyRunGroupKind,
): string {
	switch (kind) {
		case "running":
			return "No running sessions";
		case "retryQueued":
			return "Retry queue empty";
		case "released":
			return "No released run attempts";
	}
}

export function getSymphonyRunGroupEmptyDescription(
	kind: SymphonyRunGroupKind,
): string {
	switch (kind) {
		case "running":
			return "Source-owned Running rows will appear here";
		case "retryQueued":
			return "Source-owned RetryQueued rows will appear here";
		case "released":
			return "Only shown when a source owner reports Released evidence";
	}
}

export function getSymphonyRunGroupIcon(
	kind: SymphonyRunGroupKind,
): vscode.ThemeIcon {
	switch (kind) {
		case "running":
			return new vscode.ThemeIcon(
				"pulse",
				new vscode.ThemeColor("charts.blue"),
			);
		case "retryQueued":
			return new vscode.ThemeIcon(
				"history",
				new vscode.ThemeColor("charts.yellow"),
			);
		case "released":
			return new vscode.ThemeIcon(
				"check",
				new vscode.ThemeColor("charts.green"),
			);
	}
}
