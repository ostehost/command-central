import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

export function isPersistSessionAlive(
	persistSocket: string | null | undefined,
): boolean {
	if (!persistSocket) return false;

	try {
		execFileSync("persist", ["-s", persistSocket], { timeout: 500 });
		return true;
	} catch {
		return fs.existsSync(persistSocket);
	}
}
