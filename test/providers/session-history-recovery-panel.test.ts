/**
 * SessionHistoryRecoveryPanel tests
 *
 * Verifies the read-only recovery-risk webview: HTML rendering of counts,
 * retention-window risk banner, backup-first guidance, runbook link, and the
 * register helper that contributes the open command. Models the vscode-mock
 * pattern used by agent-dashboard-panel.test.ts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionHistoryRecoveryReport } from "../../src/services/session-history-recovery-service.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

let vscodeMock: ReturnType<typeof setupVSCodeMock>;

let lastMockPanel: {
	webview: { html: string };
	reveal: ReturnType<typeof mock>;
	dispose: ReturnType<typeof mock>;
	onDidDispose: ReturnType<typeof mock>;
};

beforeEach(() => {
	mock.restore();
	vscodeMock = setupVSCodeMock();
	lastMockPanel = {
		webview: { html: "" },
		reveal: mock(() => {}),
		dispose: mock(() => {}),
		onDidDispose: mock(
			(_cb: () => void, _thisArg?: unknown, _disposables?: unknown[]) => ({
				dispose: mock(() => {}),
			}),
		),
	};
	vscodeMock.window.createWebviewPanel = mock(
		() => lastMockPanel,
	) as unknown as typeof vscodeMock.window.createWebviewPanel;
});

const {
	SessionHistoryRecoveryPanel,
	registerSessionHistoryRecoveryCommands,
	OPEN_SESSION_HISTORY_RECOVERY_COMMAND,
	SESSION_HISTORY_RECOVERY_RUNBOOK_URL,
} = await import("../../src/providers/session-history-recovery-panel.js");

function makeReport(
	overrides: Partial<SessionHistoryRecoveryReport> = {},
): SessionHistoryRecoveryReport {
	return {
		scannedRoots: ["/home/.openclaw/agents/main/sessions"],
		archivedTranscripts: [],
		orphanSessionFiles: [],
		retentionDays: 30,
		pastRetentionCount: 0,
		oldestAgeDays: null,
		newestAgeDays: null,
		totalArchivedBytes: 0,
		atRisk: false,
		...overrides,
	};
}

describe("SessionHistoryRecoveryPanel", () => {
	test("creates a read-only webview (scripts disabled)", () => {
		const panel = new SessionHistoryRecoveryPanel();
		panel.show(makeReport());

		expect(vscodeMock.window.createWebviewPanel).toHaveBeenCalledWith(
			"sessionHistoryRecovery",
			"Session History Recovery Risk",
			1,
			{ enableScripts: false, retainContextWhenHidden: true },
		);
		panel.dispose();
	});

	test("renders an at-risk banner when transcripts are past retention", () => {
		const panel = new SessionHistoryRecoveryPanel();
		const html = panel.getHtml(
			makeReport({
				archivedTranscripts: [
					{
						filePath: "/home/.openclaw/agents/main/sessions/a.jsonl.deleted.x",
						deletedLabel: "x",
						mtimeMs: Date.now() - 40 * 24 * 60 * 60 * 1000,
						ageDays: 40,
						sizeBytes: 2048,
						pastRetention: true,
					},
				],
				pastRetentionCount: 1,
				oldestAgeDays: 40,
				newestAgeDays: 40,
				totalArchivedBytes: 2048,
				atRisk: true,
			}),
		);

		expect(html).toContain("past the 30-day retention window");
		expect(html).toContain("Back up before recovering");
		expect(html).toContain("prune risk");
		panel.dispose();
	});

	test("shows a within-window message when nothing is at risk", () => {
		const panel = new SessionHistoryRecoveryPanel();
		const html = panel.getHtml(
			makeReport({
				archivedTranscripts: [
					{
						filePath: "/home/.openclaw/agents/main/sessions/a.jsonl.deleted.x",
						deletedLabel: "x",
						mtimeMs: Date.now() - 2 * 24 * 60 * 60 * 1000,
						ageDays: 2,
						sizeBytes: 100,
						pastRetention: false,
					},
				],
				newestAgeDays: 2,
				oldestAgeDays: 2,
				totalArchivedBytes: 100,
			}),
		);

		expect(html).toContain("within the 30-day retention window");
		expect(html).not.toContain("Back up before recovering");
		panel.dispose();
	});

	test("always surfaces backup-first guidance and the runbook link", () => {
		const panel = new SessionHistoryRecoveryPanel();
		const html = panel.getHtml(makeReport());

		expect(html).toContain("Command Central never deletes");
		expect(html).toContain("back up before touching anything");
		expect(html).toContain(SESSION_HISTORY_RECOVERY_RUNBOOK_URL);
		panel.dispose();
	});

	test("HTML-escapes archived file paths to prevent injection", () => {
		const panel = new SessionHistoryRecoveryPanel();
		const html = panel.getHtml(
			makeReport({
				archivedTranscripts: [
					{
						filePath: "/sessions/<script>evil.jsonl.deleted.x",
						deletedLabel: "x",
						mtimeMs: Date.now(),
						ageDays: 0,
						sizeBytes: 1,
						pastRetention: false,
					},
				],
				newestAgeDays: 0,
				oldestAgeDays: 0,
				totalArchivedBytes: 1,
			}),
		);

		expect(html).not.toContain("<script>evil");
		expect(html).toContain("&lt;script&gt;evil");
		panel.dispose();
	});

	test("lists orphan session files", () => {
		const panel = new SessionHistoryRecoveryPanel();
		const html = panel.getHtml(
			makeReport({
				orphanSessionFiles: [
					{
						filePath: "/sessions/lonely.trajectory.jsonl",
						mtimeMs: Date.now(),
					},
				],
			}),
		);
		expect(html).toContain("lonely.trajectory.jsonl");
		panel.dispose();
	});
});

describe("registerSessionHistoryRecoveryCommands", () => {
	test("registers the open command id", () => {
		const disposables = registerSessionHistoryRecoveryCommands({
			panel: { show: mock(() => {}) },
			service: { scan: mock(() => makeReport()) },
		});

		expect(vscodeMock.commands.registerCommand).toHaveBeenCalledWith(
			OPEN_SESSION_HISTORY_RECOVERY_COMMAND,
			expect.any(Function),
		);
		expect(disposables).toHaveLength(1);
	});

	test("opening the command scans then shows the report (read-only)", () => {
		const show = mock(() => {});
		const report = makeReport({ pastRetentionCount: 3, atRisk: true });
		const scan = mock(() => report);

		let handler: (() => void) | undefined;
		vscodeMock.commands.registerCommand = mock(
			(_id: string, cb: () => void) => {
				handler = cb;
				return { dispose: mock(() => {}) };
			},
		) as unknown as typeof vscodeMock.commands.registerCommand;

		registerSessionHistoryRecoveryCommands({
			panel: { show },
			service: { scan },
		});
		handler?.();

		expect(scan).toHaveBeenCalledTimes(1);
		expect(show).toHaveBeenCalledWith(report);
	});
});
