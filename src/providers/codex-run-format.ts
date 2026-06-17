/**
 * Pure presentation + predicate helpers for Codex run views.
 *
 * These functions format a CodexRunView (status, source provenance, tokens,
 * retry, etc.) for display and classify run status. They were extracted from
 * AgentStatusTreeProvider, where they were stateless private methods that only
 * called one another — separating "how a Codex run is described" from the
 * provider that decides when to render it. No provider state is touched.
 */

import * as vscode from "vscode";
import type {
	CodexRunSourceRef,
	CodexRunStatus,
	CodexRunView,
	CodexRunViewField,
} from "../types/codex-run-types.js";

/** Stable display order for Codex run statuses in aggregate tooltips. */
const CODEX_RUN_STATUS_ORDER: CodexRunStatus[] = [
	"running",
	"queued",
	"waiting",
	"blocked",
	"failed",
	"timed_out",
	"lost",
	"cancelled",
	"stopped",
	"unknown",
	"succeeded",
];

export function getCodexRunEvidenceIcon(
	kind: NonNullable<CodexRunView["evidence"]>[number]["kind"],
): string {
	switch (kind) {
		case "commit":
			return "git-commit";
		case "metadata":
			return "symbol-field";
		case "file":
			return "file";
	}
}

export function formatCodexRunLastEvent(run: CodexRunView): string | undefined {
	const timestamp = run.lastEventAt
		? new Date(run.lastEventAt).toISOString()
		: undefined;
	return (
		[run.lastEvent, timestamp]
			.filter((part): part is string => Boolean(part))
			.join(" · ") || undefined
	);
}

export function formatCodexRunAuthority(run: CodexRunView): string {
	return formatCodexRunSourceRef(run.source);
}

export function formatCodexRunOwnership(run: CodexRunView): string {
	if (run.source.kind === "launcher") return "Launcher-only row";
	const metadataSources = run.mergedFrom.filter(
		(ref) => !codexRunRefsEqual(ref, run.source),
	);
	if (metadataSources.length === 0) return "Source-owned row";
	return `Source-owned row with ${metadataSources
		.map((ref) => formatCodexRunSourceKind(ref.kind))
		.join(" + ")} metadata`;
}

export function formatCodexRunAutomationSource(run: CodexRunView): string {
	if (run.trackerKind || run.issueIdentifier || run.issueId) {
		return run.trackerKind
			? `Tracker-driven (${run.trackerKind})`
			: "Tracker-driven";
	}
	if (run.flowId) return "Workstream-driven";
	return "Launcher/manual";
}

export function formatCodexRunTrackerSource(run: CodexRunView): string {
	return run.trackerKind?.trim() || "Not provided by lifecycle owner";
}

export function formatCodexRunIssue(run: CodexRunView): string | undefined {
	const id = run.issueIdentifier ?? run.issueId;
	if (!id) return undefined;
	return [id, run.issueState].filter(Boolean).join(" · ");
}

export function formatCodexRunWorkflow(run: CodexRunView): string | undefined {
	return (
		[run.workflowName, run.workflowPath, run.workflowRunId]
			.filter((part): part is string => Boolean(part))
			.join(" · ") || undefined
	);
}

export function formatCodexRunTurns(run: CodexRunView): string | undefined {
	return run.turnCount == null ? undefined : `${run.turnCount}`;
}

export function formatCodexRunTokens(run: CodexRunView): string | undefined {
	const parts = [
		run.inputTokens == null ? null : `input ${run.inputTokens}`,
		run.outputTokens == null ? null : `output ${run.outputTokens}`,
		run.totalTokens == null ? null : `total ${run.totalTokens}`,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatCodexRunRuntime(run: CodexRunView): string | undefined {
	if (run.runtimeSeconds == null) return undefined;
	return `${Math.round(run.runtimeSeconds)}s`;
}

export function formatCodexRunRetry(run: CodexRunView): string | undefined {
	const parts = [
		run.retryAttempt == null ? null : `attempt ${run.retryAttempt}`,
		run.retryDueAt ? `due ${run.retryDueAt}` : null,
		run.retryError ? `error ${run.retryError}` : null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatCodexRunFieldSourceDetails(run: CodexRunView): Array<{
	label: string;
	value: string;
}> {
	const entries = Object.entries(run.fieldSources) as Array<
		[CodexRunViewField, CodexRunSourceRef[] | undefined]
	>;
	const fieldsBySource = new Map<string, string[]>();

	for (const [field, sources] of entries) {
		if (!sources || sources.length === 0) continue;
		for (const source of sources) {
			const key = formatCodexRunSourceRef(source);
			const fields = fieldsBySource.get(key) ?? [];
			fields.push(formatCodexRunFieldName(field));
			fieldsBySource.set(key, fields);
		}
	}

	return [...fieldsBySource.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([source, fields]) => ({
			label: `Provenance from ${source}`,
			value: [...new Set(fields)].sort().join(", "),
		}));
}

export function formatCodexRunFieldName(field: CodexRunViewField): string {
	return field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

export function getCodexRunActivityTimeMs(run: CodexRunView): number {
	return run.lastEventAt ?? run.endedAt ?? run.startedAt ?? 0;
}

export function isActiveCodexRunStatus(status: CodexRunStatus): boolean {
	return (
		status === "queued" ||
		status === "running" ||
		status === "waiting" ||
		status === "blocked"
	);
}

export function isAttentionCodexRunStatus(status: CodexRunStatus): boolean {
	return status === "failed" || status === "timed_out" || status === "lost";
}

export function formatCodexRunStatus(status: CodexRunStatus): string {
	switch (status) {
		case "queued":
			return "Queued";
		case "running":
			return "Running";
		case "waiting":
			return "Waiting";
		case "blocked":
			return "Blocked";
		case "succeeded":
			return "Succeeded";
		case "failed":
			return "Failed";
		case "timed_out":
			return "Timed Out";
		case "cancelled":
			return "Cancelled";
		case "lost":
			return "Lost";
		case "stopped":
			return "Stopped";
		case "unknown":
			return "Unknown";
	}
}

export function getCodexRunStatusIcon(
	status: CodexRunStatus,
): vscode.ThemeIcon {
	switch (status) {
		case "queued":
			return new vscode.ThemeIcon(
				"loading~spin",
				new vscode.ThemeColor("charts.yellow"),
			);
		case "running":
			return new vscode.ThemeIcon(
				"pulse",
				new vscode.ThemeColor("charts.blue"),
			);
		case "waiting":
			return new vscode.ThemeIcon(
				"watch",
				new vscode.ThemeColor("charts.yellow"),
			);
		case "blocked":
			return new vscode.ThemeIcon(
				"shield",
				new vscode.ThemeColor("charts.yellow"),
			);
		case "succeeded":
			return new vscode.ThemeIcon(
				"check",
				new vscode.ThemeColor("charts.green"),
			);
		case "failed":
		case "timed_out":
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
		case "cancelled":
		case "stopped":
			return new vscode.ThemeIcon(
				"circle-slash",
				new vscode.ThemeColor("descriptionForeground"),
			);
		case "lost":
			return new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("charts.yellow"),
			);
		case "unknown":
			return new vscode.ThemeIcon(
				"question",
				new vscode.ThemeColor("descriptionForeground"),
			);
	}
}

export function formatCodexRunSource(run: CodexRunView): string {
	const refs = [
		run.source,
		...run.mergedFrom.filter((ref) => !codexRunRefsEqual(ref, run.source)),
	];
	return refs.map((ref) => formatCodexRunSourceRef(ref)).join(" + ");
}

export function formatCodexRunSourceRef(ref: CodexRunSourceRef): string {
	const id = ref.id ? ` ${ref.id}` : "";
	const pathPart = ref.path ? ` (${ref.path})` : "";
	return `${formatCodexRunSourceKind(ref.kind)}${id}${pathPart}`;
}

export function formatCodexRunSourceKind(
	kind: CodexRunSourceRef["kind"],
): string {
	switch (kind) {
		case "openclaw-task":
			return "OpenClaw task";
		case "taskflow":
			return "TaskFlow";
		case "launcher":
			return "Launcher";
		case "codex-harness":
			return "Codex harness";
		case "trajectory":
			return "Trajectory";
		case "process":
			return "Process";
	}
}

export function codexRunRefsEqual(
	left: CodexRunSourceRef,
	right: CodexRunSourceRef,
): boolean {
	return (
		left.kind === right.kind && left.id === right.id && left.path === right.path
	);
}

export function formatCodexRunsDescription(runs: CodexRunView[]): string {
	const count = runs.length;
	const workingCount = runs.filter((run) =>
		isActiveCodexRunStatus(run.status),
	).length;
	const attentionCount = runs.filter((run) =>
		isAttentionCodexRunStatus(run.status),
	).length;
	const stoppedCount = runs.filter((run) => run.status === "stopped").length;
	const cancelledCount = runs.filter(
		(run) => run.status === "cancelled",
	).length;
	const unknownCount = runs.filter((run) => run.status === "unknown").length;
	const completedCount = runs.filter(
		(run) => run.status === "succeeded",
	).length;
	const retryingCount = runs.filter(
		(run) => run.retryAttempt != null || run.retryDueAt != null,
	).length;
	const tokenTotal = runs.reduce(
		(total, run) => total + (run.totalTokens ?? 0),
		0,
	);

	const parts = [
		workingCount > 0 ? `${workingCount} working` : null,
		retryingCount > 0 ? `${retryingCount} retrying` : null,
		attentionCount > 0 ? `${attentionCount} needs attention` : null,
		stoppedCount > 0 ? `${stoppedCount} stopped` : null,
		cancelledCount > 0 ? `${cancelledCount} cancelled` : null,
		unknownCount > 0 ? `${unknownCount} unknown` : null,
		completedCount > 0 ? `${completedCount} completed` : null,
		tokenTotal > 0 ? `${tokenTotal} tokens` : null,
	].filter((part): part is string => part !== null);

	if (parts.length > 0) {
		return parts.join(" · ");
	}

	if (count === 0) {
		return "no projected runs";
	}

	return count === 1 ? "1 run" : `${count} runs`;
}

export function createCodexRunsTooltip(
	runs: CodexRunView[],
): vscode.MarkdownString {
	const statusCounts = new Map<CodexRunStatus, number>();
	for (const run of runs) {
		statusCounts.set(run.status, (statusCounts.get(run.status) ?? 0) + 1);
	}

	const statusLine = CODEX_RUN_STATUS_ORDER.filter((status) =>
		statusCounts.has(status),
	)
		.map(
			(status) =>
				`${formatCodexRunStatus(status)}: ${statusCounts.get(status)}`,
		)
		.join(" · ");
	const ownedCount = runs.filter(
		(run) => run.source.kind !== "launcher",
	).length;
	const launcherOnlyCount = runs.length - ownedCount;
	const retryingCount = runs.filter(
		(run) => run.retryAttempt != null || run.retryDueAt != null,
	).length;
	const tokenTotal = runs.reduce(
		(total, run) => total + (run.totalTokens ?? 0),
		0,
	);
	const runtimeTotal = runs.reduce(
		(total, run) => total + (run.runtimeSeconds ?? 0),
		0,
	);

	return new vscode.MarkdownString(
		[
			"**Symphony / Run Attempts**",
			`${runs.length} read-only projected ${runs.length === 1 ? "run attempt" : "run attempts"}`,
			statusLine,
			retryingCount > 0 ? `Retry queue rows: ${retryingCount}` : "",
			tokenTotal > 0 ? `Total tokens: ${tokenTotal}` : "",
			runtimeTotal > 0 ? `Runtime seconds: ${Math.round(runtimeTotal)}` : "",
			runs.length > 0
				? `${ownedCount} source-owned · ${launcherOnlyCount} launcher-only`
				: "No source rows are currently projected into this view.",
			"Lifecycle ownership stays with the source owner (OpenClaw, TaskFlow, or launcher).",
		]
			.filter((part) => part.length > 0)
			.join("\n\n"),
	);
}
