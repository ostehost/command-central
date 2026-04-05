import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as fs from "node:fs";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

// Restore real node:fs to undo mock bleed from other test files.
// The production module imports { promises } from "node:fs" which fails
// if node:fs is still mocked without a "promises" export.
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof fs;
mock.module("node:fs", () => realFs);

let vscodeMock: ReturnType<typeof setupVSCodeMock>;
let mockStatusBarItem: {
	text: string;
	tooltip: unknown;
	command: string;
	backgroundColor: unknown;
	show: ReturnType<typeof mock>;
	hide: ReturnType<typeof mock>;
	dispose: ReturnType<typeof mock>;
};

beforeEach(() => {
	mock.restore();
	// Re-register real node:fs after mock.restore() clears it
	mock.module("node:fs", () => realFs);
	mockStatusBarItem = {
		text: "",
		tooltip: "",
		command: "",
		backgroundColor: undefined,
		show: mock(),
		hide: mock(),
		dispose: mock(),
	};

	vscodeMock = setupVSCodeMock();
	// biome-ignore lint/suspicious/noExplicitAny: test mock cast
	vscodeMock.window.createStatusBarItem = mock(() => mockStatusBarItem) as any;
});

async function loadModule() {
	return await import("../../src/services/infrastructure-health-status-bar.js");
}

function createTimerHandle(): ReturnType<typeof setInterval> {
	return { id: "timer" } as unknown as ReturnType<typeof setInterval>;
}

describe("InfrastructureHealthStatusBar", () => {
	test("shows OK from readiness alone when shared summary is missing", async () => {
		const setIntervalImpl = mock(() => createTimerHandle());
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(
				async () => new Response(JSON.stringify({ ready: true })),
			),
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			setIntervalImpl,
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(pulse) OpenClaw OK");
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Gateway: ready");
		expect(tooltip.value).toContain("Snapshot: unavailable");
		expect(tooltip.value).toContain("`http://127.0.0.1:18789/readyz`");
		expect(setIntervalImpl).toHaveBeenCalledWith(expect.any(Function), 30000);
	});

	test("shows WARN and enriched tooltip when health summary reports warn", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(
				async () => new Response(JSON.stringify({ ready: true })),
			),
			readFile: mock(async () =>
				JSON.stringify({
					generatedAt: "2026-04-04T19:00:00.000Z",
					overall: {
						severity: "warn",
						summary: "Discord degraded while BlueBubbles remains healthy",
					},
					channels: {
						discord: {
							configured: true,
							healthy: false,
							detail: "reconnecting after stale heartbeat",
						},
						bluebubbles: {
							configured: true,
							healthy: true,
							detail: "ok (214ms)",
						},
					},
				}),
			),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(warning) OpenClaw WARN");
		expect((mockStatusBarItem.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.warningBackground",
		);
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Overall: warn");
		expect(tooltip.value).toContain("Discord: unhealthy");
		expect(tooltip.value).toContain("BlueBubbles: healthy");
		expect(tooltip.value).toContain("2026-04-04T19:00:00.000Z");
	});

	test("shows DOWN when the gateway is unreachable", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
			}),
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(error) OpenClaw DOWN");
		expect((mockStatusBarItem.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.errorBackground",
		);
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Gateway: unreachable");
		expect(tooltip.value).toContain("Status bar state: DOWN");
	});

	test("ignores malformed summary JSON and continues with readiness only", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(
				async () => new Response(JSON.stringify({ ready: true })),
			),
			readFile: mock(async () => "{invalid"),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(pulse) OpenClaw OK");
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Snapshot: unavailable");
	});

	test("sets the dashboard click command and clears polling on dispose", async () => {
		const clearIntervalImpl = mock();
		const timerHandle = createTimerHandle();
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(
				async () => new Response(JSON.stringify({ ready: true })),
			),
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			setIntervalImpl: mock(() => timerHandle),
			clearIntervalImpl,
		});

		expect(mockStatusBarItem.command).toBe(
			"commandCentral.openInfrastructureDashboard",
		);

		bar.dispose();

		expect(clearIntervalImpl).toHaveBeenCalledWith(timerHandle);
		expect(mockStatusBarItem.dispose).toHaveBeenCalled();
	});
});
