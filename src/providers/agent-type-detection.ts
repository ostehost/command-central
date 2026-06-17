import * as path from "node:path";
import * as vscode from "vscode";
import type { DiscoveredAgent } from "../discovery/types.js";
import type { AgentTask } from "./agent-status-tree-provider.js";

export type AgentType = "claude" | "codex" | "gemini" | "unknown";

type AgentTypeDetectionInput = {
	agent_backend?: string | null;
	cli_name?: string | null;
	process_name?: string | null;
	command?: string | null;
	model?: string | null;
	session_id?: string | null;
	id?: string | null;
};

function detectAgentTypeFromText(value: string): AgentType {
	if (
		value.includes("claude") ||
		value.includes("anthropic") ||
		value.includes("sonnet") ||
		value.includes("opus") ||
		value.includes("haiku")
	) {
		return "claude";
	}
	if (
		value.includes("codex") ||
		value.includes("openai") ||
		value.includes("gpt") ||
		/\bo1\b/.test(value) ||
		/\bo3\b/.test(value) ||
		/\bo4\b/.test(value)
	) {
		return "codex";
	}
	if (value.includes("gemini") || value.includes("google")) {
		return "gemini";
	}
	return "unknown";
}

function extractProcessName(command?: string | null): string {
	if (!command) return "";
	const [firstToken] = command.trim().split(/\s+/);
	if (!firstToken) return "";
	return path.basename(firstToken).toLowerCase();
}

export function detectAgentType(agent: AgentTypeDetectionInput): AgentType {
	const explicitHints = [
		agent.agent_backend,
		agent.cli_name,
		agent.process_name,
		extractProcessName(agent.command),
	];
	for (const hint of explicitHints) {
		if (!hint) continue;
		const detected = detectAgentTypeFromText(hint.toLowerCase());
		if (detected !== "unknown") return detected;
	}

	const fallbackHints = [
		agent.command,
		agent.model,
		agent.session_id,
		agent.id,
	];
	for (const hint of fallbackHints) {
		if (!hint) continue;
		const detected = detectAgentTypeFromText(hint.toLowerCase());
		if (detected !== "unknown") return detected;
	}

	return "unknown";
}

export function getAgentTypeIcon(
	agent: DiscoveredAgent | AgentTask | AgentTypeDetectionInput,
): vscode.ThemeIcon {
	const type = detectAgentType(agent);
	switch (type) {
		case "claude":
			return new vscode.ThemeIcon(
				"hubot",
				new vscode.ThemeColor("charts.purple"),
			);
		case "codex":
			return new vscode.ThemeIcon(
				"hubot",
				new vscode.ThemeColor("charts.green"),
			);
		case "gemini":
			return new vscode.ThemeIcon(
				"hubot",
				new vscode.ThemeColor("charts.blue"),
			);
		default:
			return new vscode.ThemeIcon("hubot");
	}
}
