/**
 * OpenClawConfigService — Watch ~/.openclaw/openclaw.json for model config.
 *
 * Reads the agents section of OpenClaw's config file and resolves
 * per-agent model and thinking defaults. Emits change events when
 * the config file is modified.
 *
 * Graceful degradation: no-op if openclaw.json doesn't exist.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

export interface OpenClawAgentModel {
	id: string;
	model: string;
	thinkingDefault?: string;
	isExplicit: boolean;
}

interface AgentModelConfig {
	primary?: string;
	fallbacks?: string[];
}

interface AgentEntry {
	id: string;
	model?: string | AgentModelConfig;
	thinkingDefault?: string;
}

interface AgentDefaults {
	model?: AgentModelConfig;
	thinkingDefault?: string;
}

interface OpenClawAgentsConfig {
	defaults?: AgentDefaults;
	list?: AgentEntry[];
}

const DEFAULT_CONFIG_PATH = path.join(
	os.homedir(),
	".openclaw",
	"openclaw.json",
);
const DEBOUNCE_MS = 300;

export class OpenClawConfigService implements vscode.Disposable {
	private watcher: fs.FSWatcher | null = null;
	private agents = new Map<string, OpenClawAgentModel>();
	private onChange: (() => void) | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly configPath: string;

	constructor(configPath?: string) {
		this.configPath = configPath ?? DEFAULT_CONFIG_PATH;
	}

	start(onChange?: () => void): void {
		this.onChange = onChange ?? null;
		this.reload();
		this.startWatching();
	}

	getAgentModel(agentId: string): OpenClawAgentModel | undefined {
		return this.agents.get(agentId);
	}

	getAllAgentModels(): OpenClawAgentModel[] {
		return Array.from(this.agents.values());
	}

	reload(): void {
		let content: string;
		try {
			content = fs.readFileSync(this.configPath, "utf-8");
		} catch {
			// Config missing/deleted — drop stale models.
			this.agents.clear();
			return;
		}

		try {
			const config = JSON.parse(content) as { agents?: OpenClawAgentsConfig };
			const agents = config.agents;
			if (!agents) {
				this.agents.clear();
				return;
			}

			const globalModel = agents.defaults?.model?.primary ?? "";
			const globalThinking = agents.defaults?.thinkingDefault;

			const next = new Map<string, OpenClawAgentModel>();
			for (const agent of agents.list ?? []) {
				const agentModel = this.resolveModel(agent.model);
				const isExplicit = agentModel !== null;

				next.set(agent.id, {
					id: agent.id,
					model: agentModel ?? globalModel,
					thinkingDefault: agent.thinkingDefault ?? globalThinking,
					isExplicit,
				});
			}
			// Swap only after a successful read+parse so a transiently
			// malformed config can't wipe the last known-good models.
			this.agents = next;
		} catch {
			// Parse error — config may be mid-edit; keep last known-good models.
		}
	}

	dispose(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.agents.clear();
	}

	// ── Internal ────────────────────────────────────────────────────────

	private resolveModel(
		model: string | AgentModelConfig | undefined,
	): string | null {
		if (!model) return null;
		if (typeof model === "string") return model;
		return model.primary ?? null;
	}

	private startWatching(): void {
		try {
			const dir = path.dirname(this.configPath);
			const basename = path.basename(this.configPath);

			this.watcher = fs.watch(dir, (_event, filename) => {
				if (filename === basename) {
					this.debouncedReload();
				}
			});
			this.watcher.on("error", () => {
				// Directory may not exist — ok
			});
		} catch {
			// Config directory doesn't exist — graceful no-op
		}
	}

	private debouncedReload(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.reload();
			this.onChange?.();
		}, DEBOUNCE_MS);
	}
}
