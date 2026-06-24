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
const SUMMARY_FRESHNESS_MS = 10 * 60_000;

type DisplayState =
	| "ok"
	| "warn"
	| "degraded"
	| "stale"
	| "down"
	| "auth-failed";
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
	/**
	 * The gateway process answered but rejected our credentials (HTTP 401/403).
	 * Distinct from unreachable: API reachability is a separate health dimension
	 * from authorization. An auth rejection means "up but locked out", never
	 * DOWN, and it is not transient so it bypasses the reachability retry.
	 */
	authFailed?: boolean;
	error?: string;
	failing: string[];
}

interface HealthSummaryInfo {
	generatedAt?: string;
	overallSeverity: SummarySeverity;
	overallSummary?: string;
	channelSummaries: Partial<Record<"discord" | "bluebubbles", string>>;
}

interface TaskServiceActivity {
	/** Number of tasks currently running — live evidence the task layer works. */
	workingCount: number;
	/** Glanceable summary matching the agent status bar, e.g. "1 working · 3 done". */
	summary?: string;
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
	/**
	 * Live task-service evidence, read at refresh time. Wire this to the same
	 * counts the agent status bar renders so the two items can never
	 * contradict each other (red DOWN next to "1 working · 3 done").
	 */
	taskActivityProbe?: () => TaskServiceActivity | null;
	/** Max age before the health-summary snapshot stops driving state. */
	summaryFreshnessMs?: number;
	nowImpl?: () => number;
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
	if (readiness.authFailed) {
		return readiness.error
			? `reachable, auth rejected (${readiness.error})`
			: "reachable, auth rejected";
	}
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

function formatTaskServiceLine(
	activity: TaskServiceActivity | null,
): string | undefined {
	if (!activity) return undefined;
	if (activity.workingCount > 0) {
		return `alive — ${activity.summary ?? `${activity.workingCount} working`}`;
	}
	return activity.summary
		? `no working tasks — ${activity.summary}`
		: "no working tasks";
}

function formatAge(ageMs: number): string {
	const minutes = Math.round(ageMs / 60_000);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.round(minutes / 60)}h`;
}

function buildTooltip(params: {
	displayState: DisplayState;
	readiness: GatewayReadiness;
	summary: HealthSummaryInfo | null;
	summaryStale: boolean;
	summaryAgeMs: number | undefined;
	taskActivity: TaskServiceActivity | null;
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

	const taskServiceLine = formatTaskServiceLine(params.taskActivity);
	if (taskServiceLine) {
		lines.push(`- Task service: ${taskServiceLine}`);
	}

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
		const staleNote =
			params.summaryStale && params.summaryAgeMs !== undefined
				? ` (stale — ${formatAge(params.summaryAgeMs)} old, not trusted for state)`
				: "";
		lines.push(`- Snapshot: ${params.summary.generatedAt}${staleNote}`);
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
	private readonly taskActivityProbe: (() => TaskServiceActivity | null) | null;
	private readonly summaryFreshnessMs: number;
	private readonly nowImpl: () => number;
	private readonly clearIntervalImpl: ClearIntervalLike;
	private pollTimer: TimerHandle | undefined;
	private refreshPromise: Promise<void> | null = null;
	/**
	 * Gateway-side evidence from the most recent completed refresh. Lets
	 * `refreshTaskActivity()` re-resolve the display state when only the task
	 * activity changed, without re-probing the gateway off-cadence.
	 */
	private lastEvidence: {
		readiness: GatewayReadiness;
		summary: HealthSummaryInfo | null;
	} | null = null;

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
		this.taskActivityProbe = options.taskActivityProbe ?? null;
		this.summaryFreshnessMs =
			options.summaryFreshnessMs ?? SUMMARY_FRESHNESS_MS;
		this.nowImpl = options.nowImpl ?? Date.now;
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

	/** Current rendered text, exposed for the integration-test API. */
	getStatusText(): string {
		return this.statusBarItem.text;
	}

	async refresh(): Promise<void> {
		if (this.refreshPromise) return this.refreshPromise;

		this.refreshPromise = (async () => {
			try {
				const [readiness, summary] = await Promise.all([
					this.readGatewayReadiness(),
					this.readHealthSummary(),
				]);
				this.lastEvidence = { readiness, summary };
				this.applyState(readiness, summary, this.readTaskActivity());
			} finally {
				this.refreshPromise = null;
			}
		})();

		return this.refreshPromise;
	}

	/**
	 * Re-read the task activity probe and re-resolve the display state from
	 * the last polled gateway evidence. Wired to agent-status tree changes so
	 * this item can never hold a contradictory DOWN beside fresh working
	 * counts for up to a full poll interval (CC-001 follow-up). Cheap by
	 * design — no gateway probe, no summary read — so it is safe on every
	 * tree refresh. A full refresh already in flight reads the latest
	 * activity when it applies state, so there is nothing to do then.
	 */
	refreshTaskActivity(): void {
		if (this.refreshPromise) return;
		if (!this.lastEvidence) {
			void this.refresh();
			return;
		}
		this.applyState(
			this.lastEvidence.readiness,
			this.lastEvidence.summary,
			this.readTaskActivity(),
		);
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
		taskActivity: TaskServiceActivity | null,
	): void {
		const summaryAgeMs = this.summaryAgeMs(summary);
		const summaryStale =
			summaryAgeMs !== undefined && summaryAgeMs > this.summaryFreshnessMs;
		const displayState = this.resolveDisplayState(
			readiness,
			summary,
			summaryStale,
			taskActivity,
		);
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
			case "degraded":
				this.statusBarItem.text = `$(warning) OpenClaw DEGRADED${scopeSuffix}`;
				this.statusBarItem.backgroundColor = new vscode.ThemeColor(
					"statusBarItem.warningBackground",
				);
				break;
			case "stale":
				this.statusBarItem.text = `$(history) OpenClaw STALE${scopeSuffix}`;
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
			case "auth-failed":
				this.statusBarItem.text = `$(key) OpenClaw AUTH${scopeSuffix}`;
				this.statusBarItem.backgroundColor = new vscode.ThemeColor(
					"statusBarItem.errorBackground",
				);
				break;
		}

		this.statusBarItem.tooltip = buildTooltip({
			displayState,
			readiness,
			summary,
			summaryStale,
			summaryAgeMs,
			taskActivity,
			readyzUrl: this.readyzUrl,
			healthSummaryPath: this.healthSummaryPath,
			gatewayScope: this.gatewayScope,
			gatewaySourceDetail: this.gatewaySourceDetail,
		});
		this.statusBarItem.show();
	}

	/**
	 * Weighs three independent evidence channels instead of collapsing every
	 * failure into DOWN:
	 *
	 * - gateway probe: live reachability (already retried once on failure)
	 * - health summary: canonical but only while fresh — a stale snapshot
	 *   must not drive the headline state in either direction
	 * - task activity: running tasks prove the task layer is alive, so a
	 *   failing gateway probe is at most a partial outage (DEGRADED)
	 *
	 * DOWN is reserved for: gateway unreachable/not-ready AND no fresh
	 * evidence of life from any other channel.
	 *
	 * AUTH-FAILED is a distinct dimension, not a flavour of DOWN: the gateway
	 * process answered but rejected our credentials (401/403). The fix is an
	 * operator action (re-auth), not a restart, so it must read differently
	 * from an outage and it outranks reachability-derived states — a healthy
	 * task layer cannot mask the fact that our view of gateway health is
	 * locked out.
	 */
	private resolveDisplayState(
		readiness: GatewayReadiness,
		summary: HealthSummaryInfo | null,
		summaryStale: boolean,
		taskActivity: TaskServiceActivity | null,
	): DisplayState {
		if (readiness.authFailed) return "auth-failed";
		const gatewayUp = readiness.reachable && readiness.ready;
		const severity = summary?.overallSeverity ?? null;

		if (gatewayUp) {
			if (severity === "critical") return summaryStale ? "stale" : "degraded";
			if (severity === "warn") return summaryStale ? "stale" : "warn";
			return "ok";
		}

		if ((taskActivity?.workingCount ?? 0) > 0) return "degraded";
		if (!summaryStale && (severity === "ok" || severity === "warn")) {
			return "degraded";
		}
		return "down";
	}

	private summaryAgeMs(summary: HealthSummaryInfo | null): number | undefined {
		if (!summary?.generatedAt) return undefined;
		const generated = Date.parse(summary.generatedAt);
		if (Number.isNaN(generated)) return undefined;
		return this.nowImpl() - generated;
	}

	private readTaskActivity(): TaskServiceActivity | null {
		if (!this.taskActivityProbe) return null;
		try {
			return this.taskActivityProbe();
		} catch {
			return null;
		}
	}

	private async readGatewayReadiness(): Promise<GatewayReadiness> {
		const first = await this.probeReadyzOnce();
		// One immediate retry absorbs transient network blips (probe timeout on
		// a saturated host, hub restart mid-poll) that previously flipped the
		// bar straight to DOWN. A reachable answer is authoritative either way.
		if (first.reachable) return first;
		return this.probeReadyzOnce();
	}

	private async probeReadyzOnce(): Promise<GatewayReadiness> {
		const controller = new AbortController();
		const timeoutId = globalThis.setTimeout(() => {
			controller.abort();
		}, this.requestTimeoutMs);

		try {
			const response = await this.fetchImpl(this.readyzUrl, {
				headers: { Accept: "application/json" },
				signal: controller.signal,
			});
			// 401/403 means the gateway process is up and the API answered, but
			// our credentials were rejected — a separate dimension from
			// reachability. Surface it as reachable+authFailed so the state
			// machine renders AUTH (re-auth needed), never a false DOWN, and so
			// it bypasses the transient-blip retry (auth rejection is not a blip).
			if (response.status === 401 || response.status === 403) {
				return {
					reachable: true,
					ready: false,
					authFailed: true,
					error: `HTTP ${response.status}`,
					failing: [],
				};
			}
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
