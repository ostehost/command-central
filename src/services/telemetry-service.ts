/**
 * TelemetryService - Anonymous, opt-in PostHog telemetry
 *
 * Privacy: No file names, repo names, paths, or code content. Ever.
 * Only: event name, timestamp, extension version, VS Code version, OS, anonymous machine ID.
 *
 * Respects both vscode.env.isTelemetryEnabled and commandCentral.telemetry.enabled.
 */

import * as vscode from "vscode";

interface TelemetryEvent {
	name: string;
	properties: Record<string, unknown>;
	timestamp: string;
}

const DEFAULT_API_KEY = "phx_ITBXbhSXphrqDXx7tw2Q88zDT38C7NfS9XFHPbeNJFoB3nu";
const POSTHOG_BATCH_URL = "https://us.i.posthog.com/batch/";
const BATCH_SIZE = 30;

export class TelemetryService implements vscode.Disposable {
	private static instance: TelemetryService | undefined;

	private readonly queue: TelemetryEvent[] = [];
	private readonly extensionVersion: string;
	private readonly vscodeVersion: string;
	private readonly os: string;
	private readonly nodeVersion: string;
	private readonly distinctId: string;

	private constructor(extensionVersion: string) {
		this.extensionVersion = extensionVersion;
		this.vscodeVersion = vscode.version;
		this.os = process.platform;
		this.nodeVersion = process.version;
		this.distinctId = vscode.env.machineId;
	}

	static getInstance(extensionVersion?: string): TelemetryService {
		if (!TelemetryService.instance) {
			TelemetryService.instance = new TelemetryService(
				extensionVersion ?? "unknown",
			);
		}
		return TelemetryService.instance;
	}

	/** Reset singleton (for testing) */
	static resetInstance(): void {
		TelemetryService.instance?.dispose();
		TelemetryService.instance = undefined;
	}

	private isEnabled(): boolean {
		try {
			if (!vscode.env.isTelemetryEnabled) {
				return false;
			}
			const config = vscode.workspace.getConfiguration("commandCentral.telemetry");
			return config.get<boolean>("enabled", true);
		} catch {
			return false;
		}
	}

	private getApiKey(): string {
		try {
			const config = vscode.workspace.getConfiguration("commandCentral.telemetry");
			const key = config.get<string>("posthogKey", "");
			return key || DEFAULT_API_KEY;
		} catch {
			return DEFAULT_API_KEY;
		}
	}

	private get standardProperties(): Record<string, string> {
		return {
			extension_version: this.extensionVersion,
			vscode_version: this.vscodeVersion,
			os: this.os,
			node_version: this.nodeVersion,
		};
	}

	track(eventName: string, properties: Record<string, unknown> = {}): void {
		try {
			if (!this.isEnabled()) return;

			this.queue.push({
				name: eventName,
				properties: { ...this.standardProperties, ...properties },
				timestamp: new Date().toISOString(),
			});

			if (this.queue.length >= BATCH_SIZE) {
				this.flush().catch(() => {});
			}
		} catch {
			// Telemetry must never crash the extension
		}
	}

	async flush(): Promise<void> {
		try {
			if (this.queue.length === 0) return;
			if (!this.isEnabled()) {
				this.queue.length = 0;
				return;
			}

			const events = this.queue.splice(0);
			const apiKey = this.getApiKey();

			const payload = {
				api_key: apiKey,
				batch: events.map((e) => ({
					event: e.name,
					properties: {
						distinct_id: this.distinctId,
						...e.properties,
					},
					timestamp: e.timestamp,
				})),
			};

			await fetch(POSTHOG_BATCH_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			}).catch(() => {});
		} catch {
			// Silent fail — telemetry must never crash the extension
		}
	}

	dispose(): void {
		this.flush().catch(() => {});
		TelemetryService.instance = undefined;
	}
}
