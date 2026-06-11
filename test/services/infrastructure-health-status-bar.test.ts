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
	vscodeMock.window.createStatusBarItem = mock(
		() => mockStatusBarItem,
	) as unknown as typeof vscodeMock.window.createStatusBarItem;
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
			nowImpl: () => Date.parse("2026-04-04T19:02:00.000Z"),
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

	// ── Evidence-weighted state matrix (CC-001) ────────────────────────────────
	// A failed gateway probe must not collapse into "OpenClaw DOWN" while other
	// evidence (running tasks, a fresh health summary) proves partial life, and
	// a stale summary snapshot must never drive the headline state.
	test("shows DEGRADED, not DOWN, when tasks are working while the hub gateway is unreachable", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			readyzUrl: "https://gateway.example.dev/readyz",
			gatewayScope: "remote",
			fetchImpl: mock(async () => {
				throw new Error("The operation was aborted");
			}),
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			taskActivityProbe: () => ({
				workingCount: 1,
				summary: "1 working · 3 done",
			}),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(warning) OpenClaw DEGRADED (hub)");
		expect((mockStatusBarItem.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.warningBackground",
		);
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Gateway (hub): unreachable");
		expect(tooltip.value).toContain("Task service: alive — 1 working · 3 done");
		expect(tooltip.value).toContain("Status bar state: DEGRADED");
	});

	test("shows DOWN when the gateway is unreachable and no tasks are working", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
			}),
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			taskActivityProbe: () => ({ workingCount: 0, summary: "3 done" }),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(error) OpenClaw DOWN");
		expect((mockStatusBarItem.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.errorBackground",
		);
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Task service: no working tasks — 3 done");
	});

	test("shows DEGRADED when a fresh summary reports ok while the gateway probe fails", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
			}),
			nowImpl: () => Date.parse("2026-06-11T12:05:00.000Z"),
			readFile: mock(async () =>
				JSON.stringify({
					generatedAt: "2026-06-11T12:00:00.000Z",
					overall: { severity: "ok", summary: "all channels healthy" },
				}),
			),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(warning) OpenClaw DEGRADED");
		expect((mockStatusBarItem.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.warningBackground",
		);
	});

	test("shows STALE when the gateway is ready but a critical summary is stale", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(
				async () => new Response(JSON.stringify({ ready: true })),
			),
			nowImpl: () => Date.parse("2026-06-11T14:00:00.000Z"),
			readFile: mock(async () =>
				JSON.stringify({
					generatedAt: "2026-06-11T12:00:00.000Z",
					overall: { severity: "critical", summary: "Discord outage" },
				}),
			),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(history) OpenClaw STALE");
		expect((mockStatusBarItem.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.warningBackground",
		);
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("(stale — 2h old, not trusted for state)");
		expect(tooltip.value).toContain("Status bar state: STALE");
	});

	test("shows DEGRADED, not DOWN, when the gateway is ready but a fresh summary is critical", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(
				async () => new Response(JSON.stringify({ ready: true })),
			),
			nowImpl: () => Date.parse("2026-06-11T12:01:00.000Z"),
			readFile: mock(async () =>
				JSON.stringify({
					generatedAt: "2026-06-11T12:00:00.000Z",
					overall: { severity: "critical", summary: "Discord outage" },
				}),
			),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(warning) OpenClaw DEGRADED");
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Overall: critical — Discord outage");
	});

	test("a stale ok summary does not downgrade an OK gateway", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(
				async () => new Response(JSON.stringify({ ready: true })),
			),
			nowImpl: () => Date.parse("2026-06-11T14:00:00.000Z"),
			readFile: mock(async () =>
				JSON.stringify({
					generatedAt: "2026-06-11T12:00:00.000Z",
					overall: { severity: "ok", summary: "all channels healthy" },
				}),
			),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(pulse) OpenClaw OK");
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("(stale — 2h old, not trusted for state)");
	});

	test("stale summary plus unreachable gateway and no tasks is still DOWN", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
			}),
			nowImpl: () => Date.parse("2026-06-11T14:00:00.000Z"),
			readFile: mock(async () =>
				JSON.stringify({
					generatedAt: "2026-06-11T12:00:00.000Z",
					overall: { severity: "ok", summary: "all channels healthy" },
				}),
			),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(error) OpenClaw DOWN");
	});

	test("retries the readyz probe once so a single blip does not flip the bar", async () => {
		let calls = 0;
		const fetchImpl = mock(async () => {
			calls++;
			if (calls === 1) throw new Error("The operation was aborted");
			return new Response(JSON.stringify({ ready: true }));
		});
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl,
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(mockStatusBarItem.text).toBe("$(pulse) OpenClaw OK");
	});

	test("a throwing task activity probe is treated as no evidence", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			fetchImpl: mock(async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
			}),
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			taskActivityProbe: () => {
				throw new Error("provider not ready");
			},
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(error) OpenClaw DOWN");
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

	// ── Hub/node-aware gateway scope ───────────────────────────────────────────
	// Nodes probe the hub gateway (resolved from ~/.openclaw/openclaw.json),
	// so the glanceable text and tooltip must label the state as the hub's —
	// never an ambiguous claim about a local gateway that isn't running here.
	test("remote scope labels OK state and tooltip with the hub gateway", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			readyzUrl: "https://gateway.example.dev/readyz",
			gatewayScope: "remote",
			gatewaySourceDetail:
				"hub gateway resolved from gateway.remote.url in ~/.openclaw/openclaw.json",
			fetchImpl: mock(
				async () => new Response(JSON.stringify({ ready: true })),
			),
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(pulse) OpenClaw OK (hub)");
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Gateway (hub): ready");
		expect(tooltip.value).toContain(
			"Health source: hub gateway resolved from gateway.remote.url",
		);
		expect(tooltip.value).toContain("`https://gateway.example.dev/readyz`");
	});

	test("remote scope labels DOWN state so a hub outage is unambiguous", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			readyzUrl: "https://gateway.example.dev/readyz",
			gatewayScope: "remote",
			fetchImpl: mock(async () => {
				throw new Error("getaddrinfo ENOTFOUND gateway.example.dev");
			}),
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(error) OpenClaw DOWN (hub)");
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Gateway (hub): unreachable");
	});

	test("local scope keeps the unsuffixed text and tooltip labels", async () => {
		const { InfrastructureHealthStatusBar } = await loadModule();
		const bar = new InfrastructureHealthStatusBar({
			gatewayScope: "local",
			gatewaySourceDetail: "local gateway (no remote gateway configured)",
			fetchImpl: mock(
				async () => new Response(JSON.stringify({ ready: true })),
			),
			readFile: mock(async () => {
				throw new Error("ENOENT");
			}),
			setIntervalImpl: mock(() => createTimerHandle()),
			clearIntervalImpl: mock(),
		});

		await bar.refresh();

		expect(mockStatusBarItem.text).toBe("$(pulse) OpenClaw OK");
		const tooltip = mockStatusBarItem.tooltip as { value: string };
		expect(tooltip.value).toContain("Gateway: ready");
		expect(tooltip.value).toContain(
			"Health source: local gateway (no remote gateway configured)",
		);
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
