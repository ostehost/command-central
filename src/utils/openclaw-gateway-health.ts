/**
 * Resolves which OpenClaw gateway health endpoint this machine should probe.
 *
 * Hub machines run the gateway locally (`gateway.mode` "local" or unset in
 * ~/.openclaw/openclaw.json) and probe 127.0.0.1. Node machines are
 * configured with `gateway.mode: "remote"` plus a `gateway.remote.url`
 * websocket endpoint — probing 127.0.0.1 on a node reports a false DOWN
 * while the hub gateway is alive. The gateway serves /readyz over HTTP(S)
 * on the same host as the websocket endpoint, so wss:// maps to https://
 * (and ws:// to http://).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LOCAL_READYZ_URL = "http://127.0.0.1:18789/readyz";

export type GatewayHealthScope = "local" | "remote";

export interface GatewayHealthSource {
	readyzUrl: string;
	scope: GatewayHealthScope;
	/** Human-readable provenance for the status bar tooltip. */
	detail: string;
}

const DEFAULT_CONFIG_PATH = path.join(
	os.homedir(),
	".openclaw",
	"openclaw.json",
);

function deriveReadyzUrl(remoteUrl: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(remoteUrl);
	} catch {
		return null;
	}
	if (parsed.protocol === "wss:") {
		parsed.protocol = "https:";
	} else if (parsed.protocol === "ws:") {
		parsed.protocol = "http:";
	} else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null;
	}
	parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/readyz`;
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
}

export function resolveGatewayHealthSource(
	configPath: string = DEFAULT_CONFIG_PATH,
): GatewayHealthSource {
	const local: GatewayHealthSource = {
		readyzUrl: LOCAL_READYZ_URL,
		scope: "local",
		detail: "local gateway (no remote gateway configured)",
	};

	let gateway: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
			gateway?: unknown;
		};
		gateway =
			parsed.gateway != null && typeof parsed.gateway === "object"
				? (parsed.gateway as Record<string, unknown>)
				: undefined;
	} catch {
		return local;
	}
	if (!gateway || gateway["mode"] !== "remote") return local;

	const remote =
		gateway["remote"] != null && typeof gateway["remote"] === "object"
			? (gateway["remote"] as Record<string, unknown>)
			: undefined;
	const remoteUrl = typeof remote?.["url"] === "string" ? remote["url"] : null;
	if (!remoteUrl) {
		return {
			...local,
			detail: `gateway.mode is "remote" but gateway.remote.url is missing in ${configPath} — falling back to local readyz`,
		};
	}

	const readyzUrl = deriveReadyzUrl(remoteUrl);
	if (!readyzUrl) {
		return {
			...local,
			detail: `gateway.remote.url (${remoteUrl}) in ${configPath} is not a usable ws/wss/http/https URL — falling back to local readyz`,
		};
	}

	return {
		readyzUrl,
		scope: "remote",
		detail: `hub gateway resolved from gateway.remote.url in ${configPath}`,
	};
}
