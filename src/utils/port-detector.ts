/**
 * Port Detector — detects listening TCP ports for processes in a project directory.
 *
 * Uses `lsof` to find listening TCP sockets and matches them by PID working directory.
 * Only intended for macOS/Linux. Async — does not block the VS Code event loop.
 */

import { execFile } from "node:child_process";
import path from "node:path";

// Local promise wrapper — calls execFile fresh each invocation so test mocks
// of node:child_process.execFile take effect even after mock.restore() runs
// between tests. (A module-load `promisify(execFile)` would cache the
// reference and break under bun's mock lifecycle.) Cost: one closure per call.
function execFileAsync(
	cmd: string,
	args: readonly string[],
	options: { encoding: BufferEncoding; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args as string[], options, (err, stdout, stderr) => {
			if (err) reject(err);
			else resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

export interface ListeningPort {
	port: number;
	pid: number;
	process: string;
}

/**
 * Extract a process cwd from `lsof -Fn` output. The cwd is on the line that
 * begins with "n" (e.g. `p1234\nn/Users/.../my-app\n`). Returns null if absent.
 */
function parseCwdFromLsof(lsofOutput: string): string | null {
	for (const line of lsofOutput.split("\n")) {
		if (line.startsWith("n")) {
			return line.slice(1);
		}
	}
	return null;
}

/**
 * True when `cwd` is `projectDir` itself or a descendant of it, using
 * path-boundary-aware containment (not substring matching, so a sibling such
 * as `my-app-copy` is not treated as belonging to `my-app`).
 */
function isWithinProject(cwd: string, projectDir: string): boolean {
	const rel = path.relative(path.resolve(projectDir), path.resolve(cwd));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Detect TCP ports being listened on by processes whose cwd is under `projectDir`.
 * Returns an empty array on error or if no ports are found. Non-blocking.
 */
export async function detectListeningPortsAsync(
	projectDir: string,
): Promise<ListeningPort[]> {
	try {
		const { stdout: lsofOutput } = await execFileAsync(
			"lsof",
			["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
			{ encoding: "utf-8", timeout: 3000 },
		);

		const candidatePorts: Array<{
			port: number;
			pid: number;
			process: string;
		}> = [];
		let currentPid = 0;
		let currentProcess = "";

		for (const line of lsofOutput.split("\n")) {
			if (line.startsWith("p")) {
				currentPid = parseInt(line.slice(1), 10);
			} else if (line.startsWith("c")) {
				currentProcess = line.slice(1);
			} else if (line.startsWith("n")) {
				const match = line.match(/:(\d+)$/);
				if (match) {
					candidatePorts.push({
						port: parseInt(match[1] ?? "0", 10),
						pid: currentPid,
						process: currentProcess,
					});
				}
			}
		}

		const ports: ListeningPort[] = [];
		for (const candidate of candidatePorts) {
			try {
				const { stdout: cwdOutput } = await execFileAsync(
					"lsof",
					["-p", String(candidate.pid), "-d", "cwd", "-Fn"],
					{ encoding: "utf-8", timeout: 2000 },
				);
				const cwd = parseCwdFromLsof(cwdOutput);
				if (cwd !== null && isWithinProject(cwd, projectDir)) {
					ports.push(candidate);
				}
			} catch {
				/* skip — process may have exited */
			}
		}

		return [...new Map(ports.map((p) => [p.port, p])).values()];
	} catch {
		return [];
	}
}
