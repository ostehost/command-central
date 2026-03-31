import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import * as realFs from "node:fs";

const execFileSyncMock = mock((..._args: unknown[]) => "");
const existsSyncMock = mock((_path: string) => false);

mock.module("node:child_process", () => ({
	...realChildProcess,
	execFileSync: execFileSyncMock,
}));

mock.module("node:fs", () => ({
	...realFs,
	existsSync: existsSyncMock,
}));

const { isPersistSessionAlive } = await import(
	"../../src/utils/persist-health.js"
);

describe("isPersistSessionAlive", () => {
	const socketPath = "/tmp/cc-persist.sock";

	beforeEach(() => {
		execFileSyncMock.mockReset();
		existsSyncMock.mockReset();
		existsSyncMock.mockReturnValue(false);
	});

	test("returns true when persist reports a live socket", () => {
		execFileSyncMock.mockImplementation(() => "");

		expect(isPersistSessionAlive(socketPath)).toBe(true);
		expect(execFileSyncMock).toHaveBeenCalledWith(
			"persist",
			["-s", socketPath],
			{
				timeout: 500,
			},
		);
		expect(existsSyncMock).not.toHaveBeenCalled();
	});

	test("falls back to the socket file when persist exits non-zero", () => {
		execFileSyncMock.mockImplementation(() => {
			throw new Error("dead session");
		});
		existsSyncMock.mockReturnValue(true);

		expect(isPersistSessionAlive(socketPath)).toBe(true);
		expect(existsSyncMock).toHaveBeenCalledWith(socketPath);
	});

	test("returns false when persist fails and the socket file is missing", () => {
		execFileSyncMock.mockImplementation(() => {
			throw new Error("dead session");
		});

		expect(isPersistSessionAlive(socketPath)).toBe(false);
		expect(existsSyncMock).toHaveBeenCalledWith(socketPath);
	});
});
