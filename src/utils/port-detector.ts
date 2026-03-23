/**
 * Port Detector — detects listening TCP ports for processes in a project directory.
 *
 * Uses `lsof` to find listening TCP sockets and matches them by PID working directory.
 * Only intended for macOS/Linux.
 */

import { execFileSync } from "node:child_process";

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
