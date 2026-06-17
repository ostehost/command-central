import { describe, expect, test } from "bun:test";
import {
	codexRunRefsEqual,
	formatCodexRunIssue,
	formatCodexRunOwnership,
	formatCodexRunRetry,
	formatCodexRunSource,
	formatCodexRunStatus,
	formatCodexRunTokens,
	isActiveCodexRunStatus,
	isAttentionCodexRunStatus,
} from "../../src/providers/codex-run-format.js";
import type {
	CodexRunSourceRef,
	CodexRunStatus,
	CodexRunView,
} from "../../src/types/codex-run-types.js";

function makeRun(overrides: Partial<CodexRunView> = {}): CodexRunView {
	return {
		runId: "run-1",
		title: "Run 1",
		source: { kind: "openclaw-task", id: "task-1" },
		mergedFrom: [],
		status: "running",
		fieldSources: {},
		...overrides,
	};
}

describe("codex-run-format", () => {
	test("formatCodexRunStatus maps each status to a human label", () => {
		const cases: Array<[CodexRunStatus, string]> = [
			["queued", "Queued"],
			["running", "Running"],
			["succeeded", "Succeeded"],
			["timed_out", "Timed Out"],
			["unknown", "Unknown"],
		];
		for (const [status, label] of cases) {
			expect(formatCodexRunStatus(status)).toBe(label);
		}
	});

	test("status predicates classify active vs attention buckets", () => {
		expect(isActiveCodexRunStatus("running")).toBe(true);
		expect(isActiveCodexRunStatus("queued")).toBe(true);
		expect(isActiveCodexRunStatus("succeeded")).toBe(false);
		expect(isAttentionCodexRunStatus("failed")).toBe(true);
		expect(isAttentionCodexRunStatus("lost")).toBe(true);
		expect(isAttentionCodexRunStatus("running")).toBe(false);
	});

	test("codexRunRefsEqual compares kind, id, and path", () => {
		const a: CodexRunSourceRef = { kind: "launcher", id: "x", path: "/p" };
		expect(codexRunRefsEqual(a, { ...a })).toBe(true);
		expect(codexRunRefsEqual(a, { ...a, id: "y" })).toBe(false);
		expect(codexRunRefsEqual(a, { ...a, kind: "taskflow" })).toBe(false);
	});

	test("formatCodexRunSource joins source + de-duplicated merged refs", () => {
		const source: CodexRunSourceRef = { kind: "openclaw-task", id: "task-1" };
		const run = makeRun({
			source,
			mergedFrom: [{ ...source }, { kind: "taskflow", id: "flow-1" }],
		});
		// The merged ref identical to source is filtered out; the distinct one stays.
		expect(formatCodexRunSource(run)).toBe(
			"OpenClaw task task-1 + TaskFlow flow-1",
		);
	});

	test("formatCodexRunOwnership distinguishes launcher-only, source-owned, and merged metadata", () => {
		expect(
			formatCodexRunOwnership(makeRun({ source: { kind: "launcher" } })),
		).toBe("Launcher-only row");
		expect(formatCodexRunOwnership(makeRun())).toBe("Source-owned row");
		expect(
			formatCodexRunOwnership(
				makeRun({ mergedFrom: [{ kind: "trajectory", id: "t" }] }),
			),
		).toBe("Source-owned row with Trajectory metadata");
	});

	test("optional field formatters return undefined when data is absent", () => {
		expect(formatCodexRunTokens(makeRun())).toBeUndefined();
		expect(formatCodexRunRetry(makeRun())).toBeUndefined();
		expect(formatCodexRunIssue(makeRun())).toBeUndefined();
		expect(
			formatCodexRunTokens(makeRun({ inputTokens: 3, totalTokens: 5 })),
		).toBe("input 3 · total 5");
		expect(
			formatCodexRunIssue(
				makeRun({ issueIdentifier: "ABC-1", issueState: "open" }),
			),
		).toBe("ABC-1 · open");
	});
});
