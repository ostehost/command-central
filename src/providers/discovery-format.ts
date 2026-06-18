/**
 * Pure formatting for the process-discovery diagnostics surface.
 *
 * These functions group and label filtered/retained process-scan entries
 * (helper binaries, interactive CLIs, stale processes, etc.) for the discovery
 * diagnostics rows in the tree. They were extracted from
 * AgentStatusTreeProvider, where they were stateless private methods that only
 * called one another and the agent-type/elapsed helpers. No provider state is
 * touched.
 */

import * as path from "node:path";
import type {
	ProcessScanDiagnosticEntry,
	ProcessScanFilterReason,
} from "../discovery/process-scanner.js";
import { formatElapsed } from "./agent-status-formatters.js";
import { detectAgentType } from "./agent-type-detection.js";

export function summarizeFilteredDiscoveryMatches(
	entries: ProcessScanDiagnosticEntry[],
): Array<{ label: string; count: number; names: string; note?: string }> {
	const groups = new Map<
		string,
		{
			label: string;
			note?: string;
			count: number;
			nameCounts: Map<string, number>;
		}
	>();

	for (const entry of entries) {
		const category = getDiscoveryFilterCategory(entry.reason);
		const group = groups.get(category.key) ?? {
			label: category.label,
			note: category.note,
			count: 0,
			nameCounts: new Map<string, number>(),
		};
		group.count += 1;
		const name = getDiscoveryDiagnosticName(entry);
		group.nameCounts.set(name, (group.nameCounts.get(name) ?? 0) + 1);
		groups.set(category.key, group);
	}

	return [...groups.values()]
		.sort((left, right) => right.count - left.count)
		.map((group) => ({
			label: group.label,
			count: group.count,
			names: formatDiscoveryNameCounts(group.nameCounts),
			note: group.note,
		}));
}

export function getDiscoveryFilterCategory(
	reason: ProcessScanFilterReason | undefined,
): { key: string; label: string; note?: string } {
	switch (reason) {
		case "excluded-binary":
			return {
				key: "helper-binaries",
				label: "Helper binaries",
				note: "consider killing stale processes",
			};
		case "interactive-process":
		case "shell-process":
			return {
				key: "interactive-cli",
				label: "Interactive CLIs",
				note: "idle sessions, not agents",
			};
		case "noise-process":
			return {
				key: "ui-noise",
				label: "UI/helper noise",
				note: "renderer/helper processes",
			};
		case "stale-process":
			return {
				key: "stale-processes",
				label: "Stale processes",
				note: "inactive streams or long-idle shells",
			};
		case "cwd-unresolved":
			return {
				key: "cwd-unresolved",
				label: "CWD lookup failures",
				note: "missing usable project directories",
			};
		case "internal-tool-dir":
			return {
				key: "internal-tools",
				label: "Internal tool directories",
				note: "internal tooling, not user agents",
			};
		default:
			return { key: "other", label: "Other filtered matches" };
	}
}

export function getDiscoveryDiagnosticName(
	entry: ProcessScanDiagnosticEntry,
): string {
	const binaryName = entry.binaryName?.trim().toLowerCase();
	if (binaryName) return binaryName;
	const detected = detectAgentType({
		process_name: entry.binaryName,
		command: entry.command,
	});
	return detected === "unknown" ? "unknown" : detected;
}

export function formatDiscoveryNameCounts(
	nameCounts: Map<string, number>,
): string {
	const entries = [...nameCounts.entries()].sort((left, right) =>
		right[1] === left[1] ? left[0].localeCompare(right[0]) : right[1] - left[1],
	);
	return entries
		.slice(0, 3)
		.map(([name, count]) => (count > 1 ? `${count} ${name}` : name))
		.join(", ");
}

export function formatRetainedDiscoveryEntry(
	entry: ProcessScanDiagnosticEntry,
	now = new Date(),
): string {
	const agentType = detectAgentType({
		process_name: entry.binaryName,
		command: entry.command,
	});
	const projectName = entry.projectDir
		? path.basename(entry.projectDir) || entry.projectDir
		: "unknown";
	return `${agentType === "unknown" ? (entry.binaryName ?? "unknown") : agentType} · ${projectName} · PID ${entry.pid} · running ${formatElapsed(entry.startTime.toISOString(), now)}`;
}
