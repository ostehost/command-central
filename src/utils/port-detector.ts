/**
 * Port Detector — detects listening TCP ports for processes in a project directory.
 *
 * Uses `lsof` to find listening TCP sockets and matches them by PID working directory.
 * Only intended for macOS/Linux.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ListeningPort {
	port: number;
	pid: number;
	process: string;
}

/**
 * Detect TCP ports being listened on by processes whose cwd is under `projectDir`.
 * Returns an empty array on error or if no ports are found.
 */
export function detectListeningPorts(projectDir: string): ListeningPort[] {
	try {
		const lsofOutput = execFileSync(
			"lsof",
			["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
			{ encoding: "utf-8", timeout: 3000 },
		);

		const ports: ListeningPort[] = [];
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
					try {
						const cwd = execFileSync(
							"lsof",
							["-p", String(currentPid), "-d", "cwd", "-Fn"],
							{ encoding: "utf-8", timeout: 2000 },
						);
						if (cwd.includes(projectDir)) {
							ports.push({
								port: parseInt(match[1] ?? "0", 10),
								pid: currentPid,
								process: currentProcess,
							});
						}
					} catch {
						/* skip — process may have exited */
					}
				}
			}
		}

		// Deduplicate by port number
		return [...new Map(ports.map((p) => [p.port, p])).values()];
	} catch {
		return [];
	}
}

/**
 * Async version of detectListeningPorts — uses non-blocking execFile.
 * Returns a promise that resolves to an empty array on error.
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
				const { stdout: cwd } = await execFileAsync(
					"lsof",
					["-p", String(candidate.pid), "-d", "cwd", "-Fn"],
					{ encoding: "utf-8", timeout: 2000 },
				);
				if (cwd.includes(projectDir)) {
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
