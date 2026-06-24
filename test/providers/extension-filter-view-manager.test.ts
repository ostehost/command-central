/**
 * Regression tests for ExtensionFilterViewManager
 *
 * PAR-77 / CP-41: Extension filter refresh rediscovers from already-filtered changes.
 *
 * The auto-refresh path (refreshExtensions, driven by subscribeToProviders +
 * provider onDidChangeTreeData) MUST re-discover extensions from the UNFILTERED
 * Git changes (getCurrentChangesUnfiltered), mirroring the initial discovery path
 * (discoverExtensions). Using the filtered-intent getCurrentChanges() would only
 * rediscover extensions from already-filtered files, so any extension the user has
 * checked away would disappear from the filter view on the next refresh — making it
 * impossible to ever re-enable it.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import type { SortedGitChangesProvider } from "../../src/git-sort/sorted-changes-provider.js";
import type { FileExtensionInfo } from "../../src/utils/extension-discovery.js";
import {
	createMockExtensionContext,
	createMockLogger,
} from "../helpers/typed-mocks.js";
import { createVSCodeMock } from "../helpers/vscode-mock.js";

const vscodeMock = createVSCodeMock();
mock.module("vscode", () => vscodeMock);

const { ExtensionFilterViewManager } = await import(
	"../../src/providers/extension-filter-view-manager.js"
);
const { ExtensionFilterState } = await import(
	"../../src/services/extension-filter-state.js"
);
const extensionTreeProviderModule = await import(
	"../../src/providers/extension-filter-tree-provider.js"
);

// ── Minimal collaborators ───────────────────────────────────────────

function makeUri(fsPath: string) {
	return { fsPath, path: fsPath, scheme: "file" };
}

interface FakeChange {
	uri: ReturnType<typeof makeUri>;
}

/**
 * Fake SortedGitChangesProvider exposing both discovery methods so the manager
 * can choose between them. Records which method the manager actually called.
 */
class FakeProvider {
	private listeners: Array<() => void> = [];

	getCurrentChangesUnfiltered = mock((): FakeChange[] => {
		// Unfiltered: ALL extensions present in Git (.ts AND .md)
		return [makeUri("a.ts"), makeUri("b.md")].map((uri) => ({ uri }));
	});

	getCurrentChanges = mock((): FakeChange[] => {
		// Filtered-intent: only the currently-enabled extension (.ts)
		return [makeUri("a.ts")].map((uri) => ({ uri }));
	});

	onDidChangeTreeData = (listener: () => void) => {
		this.listeners.push(listener);
		return { dispose: () => {} };
	};

	fireTreeDataChange(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

/** Wait for the scheduleRefresh debounce (500ms) + microtasks to settle. */
async function waitForRefresh(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 600));
}

function makeManager() {
	return new ExtensionFilterViewManager(
		createMockExtensionContext(),
		undefined, // no ProjectViewManager — refresh path uses currentProviders directly
		createMockLogger(),
		new ExtensionFilterState(undefined, "none"),
	);
}

describe("ExtensionFilterViewManager refresh (PAR-77)", () => {
	test("refresh rediscovers from UNFILTERED changes, preserving checked-away extensions", async () => {
		const manager = makeManager();

		// Capture the extensionData the manager rebuilds and pushes to the tree.
		let lastRebuilt: FileExtensionInfo[] | undefined;
		const updateSpy = spyOn(
			extensionTreeProviderModule.ExtensionFilterTreeProvider.prototype,
			"updateData",
		).mockImplementation((extensionData: FileExtensionInfo[]) => {
			lastRebuilt = extensionData;
		});

		const provider = new FakeProvider();
		const providers = [
			{
				provider: provider as unknown as SortedGitChangesProvider,
				slotId: "ws1",
			},
		];

		// Wire up the auto-refresh subscription (public seam used by setupAutoRefresh).
		manager.subscribeToProviders(providers, new Map([["ws1", "Workspace 1"]]));

		// Simulate a Git change firing the provider event -> scheduleRefresh -> refreshExtensions.
		provider.fireTreeDataChange();
		await waitForRefresh();

		// Must have used the UNFILTERED method, not the filtered-intent one.
		expect(provider.getCurrentChangesUnfiltered).toHaveBeenCalled();
		expect(provider.getCurrentChanges).not.toHaveBeenCalled();

		// The rebuilt extension list must include BOTH .ts and .md — the .md extension
		// (checked away / not in the filtered set) must survive the refresh.
		const exts = (lastRebuilt ?? []).map((e) => e.extension).sort();
		expect(exts).toEqual([".md", ".ts"]);

		updateSpy.mockRestore();
		manager.dispose();
	});
});
