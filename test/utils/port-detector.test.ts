/**
 * Port Detector Tests
 *
 * Tests the async port detection that production actually uses
 * (`detectListeningPortsAsync` — wired into AgentStatusTreeProvider).
 *
 * Mocks node:child_process.execFile (the source's own promise wrapper calls
 * it with the standard (err, stdout, stderr) callback signature), so we
 * control what `lsof` returns without spawning real processes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";

// Mock node:child_process.execFile BEFORE importing the module under test.
// We spread `...realChildProcess` so other test files that share this worker
// (and may need execFileSync etc.) continue to work — only `execFile` is
// overridden.
type ExecFileCallback = (
	err: Error | null,
	stdout: string,
	stderr: string,
) => void;
type MockExecFile = (
	cmd: string,
	args: readonly string[],
	options: unknown,
	callback: ExecFileCallback,
) => void;

const execFileMock = mock<MockExecFile>((_cmd, _args, _options, callback) =>
	callback(null, "", ""),
);

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFile: execFileMock,
}));

const { detectListeningPortsAsync } = await import(
	"../../src/utils/port-detector.js"
);

describe("detectListeningPortsAsync", () => {
	beforeEach(() => {
		// Global afterEach (test/setup/global-test-cleanup.ts) calls mock.restore()
		// which wipes file-scope module mocks. Re-establish per-test.
		mock.module("node:child_process", () => ({
			...realChildProcess,
			execFile: execFileMock,
		}));
		execFileMock.mockReset();
		execFileMock.mockImplementation((_cmd, _args, _options, callback) =>
			callback(null, "", ""),
		);
	});

	test("returns ports when lsof finds matches", async () => {
		execFileMock.mockImplementation((cmd, args, _options, callback) => {
			if (cmd === "lsof" && args[0] === "-iTCP" && args[1] === "-sTCP:LISTEN") {
				callback(null, "p1234\ncnode\nn*:3000\n", "");
			} else if (cmd === "lsof" && args[0] === "-p") {
				callback(null, "p1234\nn/Users/test/projects/my-app\n", "");
			} else {
				callback(null, "", "");
			}
		});

		const ports = await detectListeningPortsAsync(
			"/Users/test/projects/my-app",
		);
		expect(ports).toHaveLength(1);
		expect(ports[0]?.port).toBe(3000);
		expect(ports[0]?.pid).toBe(1234);
		expect(ports[0]?.process).toBe("node");
	});

	test("returns empty array on top-level lsof failure", async () => {
		execFileMock.mockImplementation((_cmd, _args, _options, callback) =>
			callback(new Error("lsof not found"), "", ""),
		);

		const ports = await detectListeningPortsAsync(
			"/Users/test/projects/my-app",
		);
		expect(ports).toEqual([]);
	});

	test("deduplicates by port number", async () => {
		execFileMock.mockImplementation((cmd, args, _options, callback) => {
			if (cmd === "lsof" && args[0] === "-iTCP" && args[1] === "-sTCP:LISTEN") {
				// Same port appears twice (e.g., IPv4 and IPv6 binds)
				callback(
					null,
					"p1234\ncnode\nn*:3000\np1234\ncnode\nn[::1]:3000\n",
					"",
				);
			} else if (cmd === "lsof" && args[0] === "-p") {
				callback(null, "p1234\nn/Users/test/projects/my-app\n", "");
			} else {
				callback(null, "", "");
			}
		});

		const ports = await detectListeningPortsAsync(
			"/Users/test/projects/my-app",
		);
		expect(ports).toHaveLength(1);
		expect(ports[0]?.port).toBe(3000);
	});

	test("returns empty array when no ports match project dir", async () => {
		execFileMock.mockImplementation((cmd, args, _options, callback) => {
			if (cmd === "lsof" && args[0] === "-iTCP" && args[1] === "-sTCP:LISTEN") {
				callback(null, "p1234\ncnode\nn*:3000\n", "");
			} else if (cmd === "lsof" && args[0] === "-p") {
				callback(null, "p1234\nn/Users/test/other-project\n", "");
			} else {
				callback(null, "", "");
			}
		});

		const ports = await detectListeningPortsAsync(
			"/Users/test/projects/my-app",
		);
		expect(ports).toEqual([]);
	});

	test("handles multiple ports from different processes", async () => {
		execFileMock.mockImplementation((cmd, args, _options, callback) => {
			if (cmd === "lsof" && args[0] === "-iTCP" && args[1] === "-sTCP:LISTEN") {
				callback(null, "p1234\ncnode\nn*:3000\np5678\ncpython3\nn*:8000\n", "");
			} else if (cmd === "lsof" && args[0] === "-p") {
				// Both processes report the same project dir
				callback(null, "p0\nn/Users/test/projects/my-app\n", "");
			} else {
				callback(null, "", "");
			}
		});

		const ports = await detectListeningPortsAsync(
			"/Users/test/projects/my-app",
		);
		expect(ports).toHaveLength(2);
		expect(ports.map((p) => p.port).sort()).toEqual([3000, 8000]);
	});

	test("skips ports whose process exited (per-pid lsof failure)", async () => {
		execFileMock.mockImplementation((cmd, args, _options, callback) => {
			if (cmd === "lsof" && args[0] === "-iTCP" && args[1] === "-sTCP:LISTEN") {
				callback(null, "p1234\ncnode\nn*:3000\np5678\ncpython3\nn*:8000\n", "");
			} else if (cmd === "lsof" && args[0] === "-p" && args[1] === "1234") {
				callback(null, "p1234\nn/Users/test/projects/my-app\n", "");
			} else if (cmd === "lsof" && args[0] === "-p" && args[1] === "5678") {
				// Process exited between the two lsof calls
				callback(new Error("ESRCH"), "", "");
			} else {
				callback(null, "", "");
			}
		});

		const ports = await detectListeningPortsAsync(
			"/Users/test/projects/my-app",
		);
		expect(ports).toHaveLength(1);
		expect(ports[0]?.port).toBe(3000);
	});
});
