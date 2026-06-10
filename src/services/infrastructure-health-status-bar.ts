import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const DEFAULT_READYZ_URL = "http://127.0.0.1:18789/readyz";
const DEFAULT_HEALTH_SUMMARY_PATH = path.join(
	os.homedir(),
	".openclaw",
	"workspace",
	"dashboard",
	"data",
	"health-summary.json",
);
const DEFAULT_COMMAND = "commandCentral.openInfrastructureDashboard";
const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 2_500;

type DisplayState = "ok" | "warn" | "down";
type SummarySeverity = "ok" | "warn" | "critical" | null;
type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;
type TimerHandle = ReturnType<typeof globalThis.setInterval>;
type SetIntervalLike = (handler: () => void, timeout: number) => TimerHandle;
type ClearIntervalLike = (timer: TimerHandle) => void;

interface GatewayReadiness {
	reachable: boolean;
	ready: boolean;
	error?: string;
	failing: string[];
}

interface HealthSummaryInfo {
	generatedAt?: string;
	overallSeverity: SummarySeverity;
	overallSummary?: string;
	channelSummaries: Partial<Record<"discord" | "bluebubbles", string>>;
}

interface InfrastructureHealthStatusBarOptions {
	command?: string;
	readyzUrl?: string;
	/**
	 * Where the probed gateway lives relative to this machine. "remote" means
	 * this is a node probing the hub gateway (resolved from
	 * ~/.openclaw/openclaw.json); the status bar labels the state "(hub)" so
	 * a DOWN reading is unambiguous. Defaults to "local".
	 */
	gatewayScope?: "local" | "remote";
	/** Provenance line for the tooltip, e.g. which config resolved the URL. */
	gatewaySourceDetail?: string;
	healthSummaryPath?: string;
	pollIntervalMs?: number;
	requestTimeoutMs?: number;
	fetchImpl?: FetchLike;
	readFile?: (filePath: string) => Promise<string>;
	setIntervalImpl?: SetIntervalLike;
	clearIntervalImpl?: ClearIntervalLike;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter((entry) => entry.length > 0);
}

function normalizeSummarySeverity(value: unknown): SummarySeverity {
	switch (value) {
		case "ok":
		case "warn":
		case "critical":
			return value;
		default:
			return null;
	}
}

function formatGatewayLine(readiness: GatewayReadiness): string {
	if (!readiness.reachable) {
		return readiness.error ? `unreachable (${readiness.error})` : "unreachable";
	}
	if (readiness.ready) return "ready";
	if (readiness.failing.length > 0) {
		return `reachable, not ready (${readiness.failing.join(", ")})`;
	}
	return "reachable, not ready";
}

function formatChannelSummary(channel: unknown): string | undefined {
	const record = asRecord(channel);
	if (!record) return undefined;

	const configured = asBoolean(record["configured"]);
	const healthy = asBoolean(record["healthy"]);
	const detail =
		asString(record["detail"]) ??
		asString(record["summary"]) ??
		asString(record["status"]);

	const parts: string[] = [];
	if (configured === false) {
		parts.push("not configured");
	} else if (healthy === true) {
		parts.push("healthy");
	} else if (healthy === false) {
		parts.push("unhealthy");
	}

	if (detail) parts.push(detail);
	return parts.length > 0 ? parts.join(" — ") : undefined;
}

function buildTooltip(params: {
	displayState: DisplayState;
	readiness: GatewayReadiness;
	summary: HealthSummaryInfo | null;
	readyzUrl: string;
	healthSummaryPath: string;
	gatewayScope: "local" | "remote";
	gatewaySourceDetail?: string;
}): vscode.MarkdownString {
	const gatewayLabel =
		params.gatewayScope === "remote" ? "Gateway (hub)" : "Gateway";
	const lines = [
		"**OpenClaw Infrastructure Health**",
		"",
		`- ${gatewayLabel}: ${formatGatewayLine(params.readiness)}`,
	];

	if (params.gatewaySourceDetail) {
		lines.push(`- Health source: ${params.gatewaySourceDetail}`);
	}

	if (params.summary?.overallSummary) {
		const severity =
			params.summary.overallSeverity === "critical"
				? "critical"
				: params.summary.overallSeverity === "warn"
					? "warn"
					: "ok";
		lines.push(`- Overall: ${severity} — ${params.summary.overallSummary}`);
	}

	for (const [label, key] of [
		["Discord", "discord"],
		["BlueBubbles", "bluebubbles"],
	] as const) {
		const channelSummary = params.summary?.channelSummaries[key];
		if (channelSummary) lines.push(`- ${label}: ${channelSummary}`);
	}

	if (params.summary?.generatedAt) {
		lines.push(`- Snapshot: ${params.summary.generatedAt}`);
	} else {
		lines.push("- Snapshot: unavailable (using readiness only)");
	}

	lines.push(
		"",
		`Status bar state: ${params.displayState.toUpperCase()}`,
		`Fast signal: \`${params.readyzUrl}\``,
		`Canonical detail: \`${params.healthSummaryPath}\``,
		"Click to open `dashboard.partnerai.dev`.",
	);

	return new vscode.MarkdownString(lines.join("\n"));
}

export class InfrastructureHealthStatusBar implements vscode.Disposable {
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly fetchImpl: FetchLike;
	private readonly readFile: (filePath: string) => Promise<string>;
	private readonly readyzUrl: string;
	private readonly gatewayScope: "local" | "remote";
	private readonly gatewaySourceDetail: string | undefined;
	private readonly healthSummaryPath: string;
	private readonly requestTimeoutMs: number;
	private readonly clearIntervalImpl: ClearIntervalLike;
	private pollTimer: TimerHandle | undefined;
	private refreshPromise: Promise<void> | null = null;

	constructor(options: InfrastructureHealthStatusBarOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.readFile =
			options.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8"));
		this.readyzUrl = options.readyzUrl ?? DEFAULT_READYZ_URL;
		this.gatewayScope = options.gatewayScope ?? "local";
		this.gatewaySourceDetail = options.gatewaySourceDetail;
		this.healthSummaryPath =
			options.healthSummaryPath ?? DEFAULT_HEALTH_SUMMARY_PATH;
		this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		this.clearIntervalImpl =
			options.clearIntervalImpl ?? globalThis.clearInterval;

		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			60,
		);
		this.statusBarItem.command = options.command ?? DEFAULT_COMMAND;
		this.statusBarItem.text = "$(sync~spin) OpenClaw ...";
		this.statusBarItem.tooltip = "Checking OpenClaw infrastructure health…";
		this.statusBarItem.show();

		void this.refresh();

		const setIntervalImpl = options.setIntervalImpl ?? globalThis.setInterval;
		const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
		this.pollTimer = setIntervalImpl(() => {
			void this.refresh();
		}, pollIntervalMs);
	}

	async refresh(): Promise<void> {
		if (this.refreshPromise) return this.refreshPromise;

		this.refreshPromise = (async () => {
			try {
				const [readiness, summary] = await Promise.all([
					this.readGatewayReadiness(),
					this.readHealthSummary(),
				]);
				this.applyState(readiness, summary);
			} finally {
				this.refreshPromise = null;
			}
		})();

		return this.refreshPromise;
	}

	dispose(): void {
		if (this.pollTimer !== undefined) {
			this.clearIntervalImpl(this.pollTimer);
		}
		this.statusBarItem.dispose();
	}

	private applyState(
		readiness: GatewayReadiness,
		summary: HealthSummaryInfo | null,
	): void {
		const displayState = this.resolveDisplayState(readiness, summary);
		// On nodes the probe target is the hub gateway — label the glanceable
		// text so OK/DOWN is never read as a claim about a local gateway.
		const scopeSuffix = this.gatewayScope === "remote" ? " (hub)" : "";

		switch (displayState) {
			case "ok":
				this.statusBarItem.text = `$(pulse) OpenClaw OK${scopeSuffix}`;
				this.statusBarItem.backgroundColor = undefined;
				break;
			case "warn":
				this.statusBarItem.text = `$(warning) OpenClaw WARN${scopeSuffix}`;
				this.statusBarItem.backgroundColor = new vscode.ThemeColor(
					"statusBarItem.warningBackground",
				);
				break;
			case "down":
				this.statusBarItem.text = `$(error) OpenClaw DOWN${scopeSuffix}`;
				this.statusBarItem.backgroundColor = new vscode.ThemeColor(
					"statusBarItem.errorBackground",
				);
				break;
		}

		this.statusBarItem.tooltip = buildTooltip({
			displayState,
			readiness,
			summary,
			readyzUrl: this.readyzUrl,
			healthSummaryPath: this.healthSummaryPath,
			gatewayScope: this.gatewayScope,
			gatewaySourceDetail: this.gatewaySourceDetail,
		});
		this.statusBarItem.show();
	}

	private resolveDisplayState(
		readiness: GatewayReadiness,
		summary: HealthSummaryInfo | null,
	): DisplayState {
		if (!readiness.reachable || !readiness.ready) return "down";
		if (summary?.overallSeverity === "critical") return "down";
		if (summary?.overallSeverity === "warn") return "warn";
		return "ok";
	}

	private async readGatewayReadiness(): Promise<GatewayReadiness> {
		const controller = new AbortController();
		const timeoutId = globalThis.setTimeout(() => {
			controller.abort();
		}, this.requestTimeoutMs);

		try {
			const response = await this.fetchImpl(this.readyzUrl, {
				headers: { Accept: "application/json" },
				signal: controller.signal,
			});
			const data = asRecord(await response.json().catch(() => null));
			return {
				reachable: true,
				ready: asBoolean(data?.["ready"]) ?? response.status === 200,
				failing: asStringArray(data?.["failing"]),
			};
		} catch (error) {
			return {
				reachable: false,
				ready: false,
				error: error instanceof Error ? error.message : String(error),
				failing: [],
			};
		} finally {
			globalThis.clearTimeout(timeoutId);
		}
	}

	private async readHealthSummary(): Promise<HealthSummaryInfo | null> {
		try {
			const raw = await this.readFile(this.healthSummaryPath);
			const parsed = asRecord(JSON.parse(raw));
			if (!parsed) return null;

			const overall = asRecord(parsed["overall"]);
			const channels = asRecord(parsed["channels"]);

			return {
				generatedAt: asString(parsed["generatedAt"]),
				overallSeverity: normalizeSummarySeverity(overall?.["severity"]),
				overallSummary: asString(overall?.["summary"]),
				channelSummaries: {
					discord: formatChannelSummary(channels?.["discord"]),
					bluebubbles: formatChannelSummary(channels?.["bluebubbles"]),
				},
			};
		} catch {
			return null;
		}
	}
}
