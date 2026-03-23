/**
 * Port Detector Tests
 *
 * Tests port detection via lsof output parsing.
 * Uses mocking to avoid actual system calls in tests.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";

// Mock child_process before importing the module under test
const execFileSyncMock = mock((..._args: unknown[]) => "");

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

const { detectListeningPorts } = await import(
	"../../src/utils/port-detector.js"
);

describe("detectListeningPorts", () => {
	beforeEach(() => {
		execFileSyncMock.mockReset();
	});

	test("returns ports when lsof finds matches", () => {
		// First call: lsof -iTCP listing
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[]];
			if (cmd === "lsof" && args[0] === "-iTCP" && args[1] === "-sTCP:LISTEN") {
				return "p1234\ncnode\nn*:3000\n";
			}
			// Second call: lsof -p for cwd check
			if (cmd === "lsof" && args[0] === "-p") {
				return "p1234\nn/Users/test/projects/my-app\n";
			}
			return "";
		});

		const ports = detectListeningPorts("/Users/test/projects/my-app");
		expect(ports).toHaveLength(1);
		expect(ports[0]?.port).toBe(3000);
		expect(ports[0]?.pid).toBe(1234);
		expect(ports[0]?.process).toBe("node");
	});

	test("returns empty array on error", () => {
		execFileSyncMock.mockImplementation(() => {
			throw new Error("lsof not found");
		});

		const ports = detectListeningPorts("/Users/test/projects/my-app");
		expect(ports).toEqual([]);
	});

	test("deduplicates by port number", () => {
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[]];
			if (cmd === "lsof" && args[0] === "-iTCP" && args[1] === "-sTCP:LISTEN") {
				// Same port appears twice (e.g., IPv4 and IPv6)
				return "p1234\ncnode\nn*:3000\np1234\ncnode\nn[::1]:3000\n";
			}
			if (cmd === "lsof" && args[0] === "-p") {
				return "p1234\nn/Users/test/projects/my-app\n";
			}
			return "";
		});

		const ports = detectListeningPorts("/Users/test/projects/my-app");
		expect(ports).toHaveLength(1);
		expect(ports[0]?.port).toBe(3000);
	});

	test("returns empty array when no ports match project dir", () => {
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[]];
			if (cmd === "lsof" && args[0] === "-iTCP" && args[1] === "-sTCP:LISTEN") {
				return "p1234\ncnode\nn*:3000\n";
			}
			if (cmd === "lsof" && args[0] === "-p") {
				return "p1234\nn/Users/test/other-project\n";
			}
			return "";
		});

		const ports = detectListeningPorts("/Users/test/projects/my-app");
		expect(ports).toEqual([]);
	});

	test("handles multiple ports from different processes", () => {
		execFileSyncMock.mockImplementation((...fnArgs: unknown[]) => {
			const [cmd, args] = fnArgs as [string, string[]];
			if (cmd === "lsof" && args[0] === "-iTCP" && args[1] === "-sTCP:LISTEN") {
				return "p1234\ncnode\nn*:3000\np5678\ncpython3\nn*:8000\n";
			}
			if (cmd === "lsof" && args[0] === "-p") {
				return "p0\nn/Users/test/projects/my-app\n";
			}
			return "";
		});

		const ports = detectListeningPorts("/Users/test/projects/my-app");
		expect(ports).toHaveLength(2);
		expect(ports.map((p) => p.port).sort()).toEqual([3000, 8000]);
	});
});
