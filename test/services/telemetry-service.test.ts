/**
 * Tests for TelemetryService
 * Following CLAUDE.md test patterns with Bun's native test runner
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

// Mutable state controlled per-test via the mock closure
const mockState = {
	telemetryEnabled: true,
	configEnabled: true as boolean | undefined,
};

// Re-register vscode mock with telemetry-specific fields.
// Must be called in beforeEach because global-test-cleanup.ts calls mock.restore() after each test.
function setupVSCodeMock() {
	const base = createVSCodeMock();
	mock.module("vscode", () => ({
		...base,
		version: "1.85.0",
		env: {
			get isTelemetryEnabled() {
				return mockState.telemetryEnabled;
			},
			machineId: "test-machine-id",
		},
		workspace: {
			...base.workspace,
			getConfiguration: (_section: string) => ({
				get: (key: string, defaultValue?: unknown) => {
					if (key === "enabled") {
						return mockState.configEnabled ?? defaultValue;
					}
					if (key === "posthogKey") return "";
					return defaultValue;
				},
			}),
		},
	}));
}

// Register once at module level for the initial import
setupVSCodeMock();

// Dynamic import helper — the module is cached after first import, mock.module above applies
async function getTelemetryService() {
	const mod = await import("../../src/services/telemetry-service.js");
	return mod.TelemetryService;
}

describe("TelemetryService", () => {
	let mockFetch: ReturnType<typeof mock>;

	beforeEach(() => {
		// Re-register after global-test-cleanup's mock.restore()
		setupVSCodeMock();
		mockState.telemetryEnabled = true;
		mockState.configEnabled = true;

		mockFetch = mock(() => Promise.resolve({ ok: true }));
		global.fetch = mockFetch as unknown as typeof fetch;
	});

	describe("Singleton", () => {
		test("creates singleton instance via getInstance()", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const instance = TelemetryService.getInstance("1.0.0");
			expect(instance).toBeInstanceOf(TelemetryService);
		});

		test("returns same instance on second getInstance() call", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const first = TelemetryService.getInstance("1.0.0");
			const second = TelemetryService.getInstance("1.0.0");
			expect(first).toBe(second);
		});

		test("resetInstance() creates a fresh instance", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const first = TelemetryService.getInstance("1.0.0");
			TelemetryService.resetInstance();
			const second = TelemetryService.getInstance("2.0.0");
			expect(first).not.toBe(second);
		});
	});

	describe("Telemetry gate", () => {
		test("sends nothing when vscode.env.isTelemetryEnabled is false", async () => {
			mockState.telemetryEnabled = false;
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");

			service.track("test_event");
			await service.flush();

			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("sends nothing when commandCentral.telemetry.enabled is false", async () => {
			mockState.configEnabled = false;
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");

			service.track("test_event");
			await service.flush();

			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("does not track events when both telemetry checks fail", async () => {
			mockState.telemetryEnabled = false;
			mockState.configEnabled = false;
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");

			service.track("event_one");
			service.track("event_two");
			await service.flush();

			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe("track()", () => {
		test("queues events with correct event name", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");
			service.track("my_test_event");
			await service.flush();

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(options.body as string) as {
				batch: Array<{ event: string }>;
			};
			expect(body.batch[0]?.event).toBe("my_test_event");
		});

		test("includes standard properties in each event", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");
			service.track("prop_test");
			await service.flush();

			const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(options.body as string) as {
				batch: Array<{ properties: Record<string, string> }>;
			};
			const props = body.batch[0]?.properties;
			expect(props).toBeDefined();
			expect(props?.["extension_version"]).toBe("1.0.0");
			expect(props?.["vscode_version"]).toBe("1.85.0");
			expect(props?.["os"]).toBe(process.platform);
			expect(props?.["node_version"]).toBe(process.version);
		});

		test("uses vscode.env.machineId as distinct_id", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");
			service.track("machine_id_test");
			await service.flush();

			const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(options.body as string) as {
				batch: Array<{ properties: Record<string, string> }>;
			};
			expect(body.batch[0]?.properties?.["distinct_id"]).toBe(
				"test-machine-id",
			);
		});
	});

	describe("flush()", () => {
		test("sends batch POST to PostHog endpoint", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");
			service.track("flush_test");
			await service.flush();

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("https://us.i.posthog.com/batch/");
			expect(options.method).toBe("POST");
			expect(
				(options.headers as Record<string, string>)?.["Content-Type"],
			).toBe("application/json");
		});

		test("empty queue flush is a no-op", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");
			await service.flush();
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("silently handles network errors without throwing", async () => {
			mockFetch = mock(() => Promise.reject(new Error("Network error")));
			global.fetch = mockFetch as unknown as typeof fetch;

			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");
			service.track("net_error_test");

			await expect(service.flush()).resolves.toBeUndefined();
		});
	});

	describe("Auto-flush", () => {
		test("flushes automatically when batch reaches 30 events", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");

			for (let i = 0; i < 30; i++) {
				service.track(`event_${i}`);
			}

			// Allow auto-flush microtask to settle
			await Promise.resolve();

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [_url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(options.body as string) as {
				batch: Array<unknown>;
			};
			expect(body.batch.length).toBe(30);
		});
	});

	describe("dispose()", () => {
		test("calls flush and clears singleton", async () => {
			const TelemetryService = await getTelemetryService();
			TelemetryService.resetInstance();
			const service = TelemetryService.getInstance("1.0.0");
			service.track("dispose_test");

			service.dispose();
			await Promise.resolve();

			const fresh = TelemetryService.getInstance("2.0.0");
			expect(fresh).not.toBe(service);
		});
	});
});
