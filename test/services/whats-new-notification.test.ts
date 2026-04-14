/**
 * Tests for the What's New notification logic in extension activation.
 * Covers version 0.6.0 recency-first default notification.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const WHATS_NEW_VERSION = "0.6.0";
const WHATS_NEW_MESSAGE =
	"Command Central 0.6.0: Agent Status now sorts by recency by default. Your most recent agent runs appear first.";

// Per-test mutable state
const mockState = {
	hasActivatedBefore: false,
	whatsNewShown: "",
};

function setupVSCodeMock() {
	const base = createVSCodeMock();
	mock.module("vscode", () => ({
		...base,
		window: {
			...base.window,
			showInformationMessage: mock(() => Promise.resolve("Got it")),
		},
	}));
}

// Register at module level for the initial import
setupVSCodeMock();

function makeContext() {
	const store = new Map<string, unknown>([
		["commandCentral.hasActivatedBefore", mockState.hasActivatedBefore],
		["commandCentral.whatsNewShown", mockState.whatsNewShown],
	]);

	return {
		globalState: {
			get: mock(<T>(key: string, defaultValue?: T): T => {
				return (store.has(key) ? store.get(key) : defaultValue) as T;
			}),
			update: mock((key: string, value: unknown) => {
				store.set(key, value);
				return Promise.resolve();
			}),
		},
	};
}

// The notification logic extracted from extension.ts for unit testing
async function runWhatsNewLogic(
	context: ReturnType<typeof makeContext>,
	telemetry: {
		track: (event: string, props?: Record<string, unknown>) => void;
	},
) {
	const vscode = await import("vscode");
	const hasActivatedBefore = context.globalState.get(
		"commandCentral.hasActivatedBefore",
		false,
	) as boolean;
	const whatsNewShown = context.globalState.get(
		"commandCentral.whatsNewShown",
		"",
	) as string;
	if (hasActivatedBefore && whatsNewShown !== WHATS_NEW_VERSION) {
		vscode.window.showInformationMessage(WHATS_NEW_MESSAGE, "Got it");
		context.globalState.update(
			"commandCentral.whatsNewShown",
			WHATS_NEW_VERSION,
		);
		telemetry.track("cc_whats_new_shown", { version: WHATS_NEW_VERSION });
	}
}

describe("What's New notification (0.6.0)", () => {
	let telemetryTrack: ReturnType<typeof mock>;

	beforeEach(() => {
		setupVSCodeMock();
		telemetryTrack = mock(() => {});
	});

	test("shows notification for returning user who hasn't seen this version", async () => {
		mockState.hasActivatedBefore = true;
		mockState.whatsNewShown = "";

		const ctx = makeContext();
		await runWhatsNewLogic(ctx, { track: telemetryTrack });

		const vscode = await import("vscode");
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			WHATS_NEW_MESSAGE,
			"Got it",
		);
	});

	test("does NOT show notification for brand new user (first activation)", async () => {
		mockState.hasActivatedBefore = false;
		mockState.whatsNewShown = "";

		const ctx = makeContext();
		await runWhatsNewLogic(ctx, { track: telemetryTrack });

		const vscode = await import("vscode");
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("does NOT show notification if already shown for this version", async () => {
		mockState.hasActivatedBefore = true;
		mockState.whatsNewShown = WHATS_NEW_VERSION;

		const ctx = makeContext();
		await runWhatsNewLogic(ctx, { track: telemetryTrack });

		const vscode = await import("vscode");
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("updates globalState after showing notification", async () => {
		mockState.hasActivatedBefore = true;
		mockState.whatsNewShown = "";

		const ctx = makeContext();
		await runWhatsNewLogic(ctx, { track: telemetryTrack });

		expect(ctx.globalState.update).toHaveBeenCalledWith(
			"commandCentral.whatsNewShown",
			WHATS_NEW_VERSION,
		);
	});
});
