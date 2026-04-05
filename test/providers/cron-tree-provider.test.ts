import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CronJob, CronTreeElement } from "../../src/types/cron-types.js";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

// ── VS Code mock ────────────────────────────────────────────────────

let cronConfig: Record<string, unknown> = {};
const vscodeMock = createVSCodeMock();
vscodeMock.workspace.getConfiguration = ((section?: string) => ({
	get: <T>(key: string, defaultValue?: T): T | undefined => {
		if (section === "commandCentral.cron") {
			return (cronConfig[key] as T) ?? defaultValue;
		}
		return defaultValue;
	},
})) as typeof vscodeMock.workspace.getConfiguration;
mock.module("vscode", () => vscodeMock);

// ── Fake CronService ────────────────────────────────────────────────

class FakeCronService {
	private jobs: CronJob[] = [];
	isInstalled = true;

	setJobs(jobs: CronJob[]): void {
		this.jobs = jobs;
	}

	getJobs(): CronJob[] {
		return this.jobs;
	}

	reload(): void {}
	dispose(): void {}
}

const { CronTreeProvider, getJobIcon, formatRelativeTime, formatDuration } =
	await import("../../src/providers/cron-tree-provider.js");

// ── Test data ───────────────────────────────────────────────────────

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
	return {
		id: "test-1",
		name: "Test Job",
		enabled: true,
		schedule: { kind: "cron", expr: "0 9 * * *" },
		sessionTarget: "main",
		payload: { kind: "agentTurn", message: "hello" },
		state: { lastStatus: "ok", lastRunAtMs: Date.now() - 3600000 },
		...overrides,
	};
}

/** Get element at index, throwing if undefined */
function at<T>(arr: T[], index: number): T {
	const el = arr[index];
	if (el === undefined) throw new Error(`No element at index ${index}`);
	return el;
}

describe("CronTreeProvider", () => {
	let service: FakeCronService;
	let provider: InstanceType<typeof CronTreeProvider>;

	beforeEach(() => {
		cronConfig = {};
		service = new FakeCronService();
		provider = new CronTreeProvider(
			service as unknown as ConstructorParameters<typeof CronTreeProvider>[0],
		);
	});

	afterEach(() => {
		provider.dispose();
	});

	test("shows guidance when OpenClaw not installed", () => {
		service.isInstalled = false;
		const children = provider.getChildren(undefined);
		expect(children).toHaveLength(1);
		const first = at(children, 0);
		expect(first.kind).toBe("detail");
		if (first.kind === "detail") {
			expect(first.label).toContain("not installed");
		}
	});

	test("shows empty state when no jobs", () => {
		service.setJobs([]);
		const children = provider.getChildren(undefined);
		expect(children).toHaveLength(1);
		const first = at(children, 0);
		expect(first.kind).toBe("detail");
		if (first.kind === "detail") {
			expect(first.label).toContain("No scheduled");
		}
	});

	test("summary node shows correct counts", () => {
		service.setJobs([
			makeJob({ id: "1", name: "A", enabled: true }),
			makeJob({ id: "2", name: "B", enabled: true }),
			makeJob({ id: "3", name: "C", enabled: false }),
		]);

		const roots = provider.getChildren(undefined);
		expect(roots).toHaveLength(1);
		const root = at(roots, 0);
		expect(root.kind).toBe("summary");
		if (root.kind === "summary") {
			expect(root.activeCount).toBe(2);
			expect(root.disabledCount).toBe(1);
		}

		const item = provider.getTreeItem(root);
		expect(item.label).toContain("2 active");
		expect(item.label).toContain("1 disabled");
	});

	test("job nodes returned as children of summary", () => {
		service.setJobs([
			makeJob({ id: "1", name: "A" }),
			makeJob({ id: "2", name: "B" }),
		]);

		const roots = provider.getChildren(undefined);
		const jobs = provider.getChildren(at(roots, 0));
		expect(jobs).toHaveLength(2);
		expect(at(jobs, 0).kind).toBe("job");
		expect(at(jobs, 1).kind).toBe("job");
	});

	test("disabled jobs hidden when showDisabled is false", () => {
		cronConfig["showDisabled"] = false;
		service.setJobs([
			makeJob({ id: "1", name: "Active", enabled: true }),
			makeJob({ id: "2", name: "Disabled", enabled: false }),
		]);

		const roots = provider.getChildren(undefined);
		const jobs = provider.getChildren(at(roots, 0));
		expect(jobs).toHaveLength(1);
		const first = at(jobs, 0);
		if (first.kind === "job") {
			expect(first.job.name).toBe("Active");
		}
	});

	test("detail children contain Schedule, Model, Last, Next", () => {
		const job = makeJob({
			agentId: "main",
			payload: {
				kind: "agentTurn",
				message: "hi",
				model: "gpt-5.4",
			},
			state: {
				lastStatus: "ok",
				lastRunAtMs: Date.now() - 3600000,
				lastDurationMs: 45000,
				nextRunAtMs: Date.now() + 7200000,
			},
		});
		service.setJobs([job]);

		const roots = provider.getChildren(undefined);
		const jobs = provider.getChildren(at(roots, 0));
		const details = provider.getChildren(at(jobs, 0));

		const labels = details.map((d) => (d.kind === "detail" ? d.label : ""));
		expect(labels).toContain("Schedule");
		expect(labels).toContain("Model");
		expect(labels).toContain("Agent");
		expect(labels).toContain("Last");
		expect(labels).toContain("Next");
	});

	test("enabled job with ok status has cronJob contextValue", () => {
		service.setJobs([makeJob({ enabled: true, state: { lastStatus: "ok" } })]);
		const roots = provider.getChildren(undefined);
		const jobs = provider.getChildren(at(roots, 0));
		const item = provider.getTreeItem(at(jobs, 0));
		expect(item.contextValue).toBe("cronJob");
	});

	test("disabled job has cronJobDisabled contextValue", () => {
		service.setJobs([makeJob({ enabled: false, state: {} })]);
		const roots = provider.getChildren(undefined);
		const jobs = provider.getChildren(at(roots, 0));
		const item = provider.getTreeItem(at(jobs, 0));
		expect(item.contextValue).toBe("cronJobDisabled");
	});

	test("getParent returns correct parent for detail", () => {
		const job = makeJob();
		service.setJobs([job]);
		const detail: CronTreeElement = {
			kind: "detail",
			jobId: job.id,
			label: "Schedule",
			value: "test",
		};
		const parent = provider.getParent(detail);
		expect(parent?.kind).toBe("job");
	});

	test("dispose cleans up", () => {
		// Should not throw
		provider.dispose();
	});
});

describe("getJobIcon", () => {
	test("enabled job with ok status → green check", () => {
		const icon = getJobIcon(
			makeJob({ enabled: true, state: { lastStatus: "ok" } }),
		);
		expect(icon.id).toBe("check");
	});

	test("enabled job with error status → red error", () => {
		const icon = getJobIcon(
			makeJob({ enabled: true, state: { lastStatus: "error" } }),
		);
		expect(icon.id).toBe("error");
	});

	test("enabled job with consecutive errors → yellow warning", () => {
		const icon = getJobIcon(
			makeJob({
				enabled: true,
				state: { lastStatus: "ok", consecutiveErrors: 3 },
			}),
		);
		expect(icon.id).toBe("warning");
	});

	test("disabled job → gray pause", () => {
		const icon = getJobIcon(makeJob({ enabled: false, state: {} }));
		expect(icon.id).toBe("debug-pause");
	});
});

describe("formatRelativeTime", () => {
	test("past time — minutes", () => {
		const result = formatRelativeTime(Date.now() - 5 * 60 * 1000);
		expect(result).toBe("5m ago");
	});

	test("past time — hours", () => {
		const result = formatRelativeTime(Date.now() - 19 * 60 * 60 * 1000);
		expect(result).toBe("19h ago");
	});

	test("future time — minutes", () => {
		const result = formatRelativeTime(Date.now() + 6 * 60 * 1000);
		expect(result).toBe("in 6m");
	});

	test("future time — days", () => {
		const result = formatRelativeTime(Date.now() + 6 * 24 * 60 * 60 * 1000);
		expect(result).toBe("in 6d");
	});

	test("less than a minute ago", () => {
		const result = formatRelativeTime(Date.now() - 30000);
		expect(result).toBe("<1m ago");
	});
});

describe("formatDuration", () => {
	test("seconds", () => {
		expect(formatDuration(45000)).toBe("45s");
	});

	test("minutes", () => {
		expect(formatDuration(900000)).toBe("15m");
	});

	test("hours", () => {
		expect(formatDuration(7200000)).toBe("2h");
	});
});
