/**
 * resolveGatewayHealthSource — hub/node-aware readyz resolution.
 *
 * Hub machines (gateway.mode "local" or unset) probe 127.0.0.1. Node
 * machines (gateway.mode "remote" + gateway.remote.url) probe the hub's
 * readyz derived from the websocket URL (wss → https, ws → http), so the
 * status bar never reports a false local DOWN while the hub is alive.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type * as _fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Restore real node:fs to undo mock bleed from other test files — the
// resolver reads the config file directly via fs.readFileSync.
const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof _fs;
mock.module("node:fs", () => realFs);

import {
	LOCAL_READYZ_URL,
	resolveGatewayHealthSource,
} from "../../src/utils/openclaw-gateway-health.js";

const tmpDirs: string[] = [];
function writeConfig(contents: string): string {
	const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "gateway-health-"));
	tmpDirs.push(dir);
	const configPath = path.join(dir, "openclaw.json");
	realFs.writeFileSync(configPath, contents, "utf-8");
	return configPath;
}

beforeEach(() => {
	mock.module("node:fs", () => realFs);
});

afterAll(() => {
	for (const dir of tmpDirs) {
		try {
			realFs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

describe("resolveGatewayHealthSource", () => {
	test("missing config file → local default", () => {
		const source = resolveGatewayHealthSource(
			"/nonexistent/openclaw-gateway-health-test.json",
		);
		expect(source.readyzUrl).toBe(LOCAL_READYZ_URL);
		expect(source.scope).toBe("local");
	});

	test("malformed config JSON → local default", () => {
		const configPath = writeConfig("{not json");
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe(LOCAL_READYZ_URL);
		expect(source.scope).toBe("local");
	});

	test("gateway.mode local → local default", () => {
		const configPath = writeConfig(
			JSON.stringify({ gateway: { mode: "local" } }),
		);
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe(LOCAL_READYZ_URL);
		expect(source.scope).toBe("local");
	});

	test("no gateway section → local default", () => {
		const configPath = writeConfig(JSON.stringify({ agents: [] }));
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe(LOCAL_READYZ_URL);
		expect(source.scope).toBe("local");
	});

	test("remote mode + wss url → https readyz on the hub host", () => {
		const configPath = writeConfig(
			JSON.stringify({
				gateway: {
					mode: "remote",
					remote: { url: "wss://gateway.partnerai.dev" },
				},
			}),
		);
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe("https://gateway.partnerai.dev/readyz");
		expect(source.scope).toBe("remote");
		expect(source.detail).toContain(configPath);
	});

	test("remote mode + ws url with port and path prefix → http readyz", () => {
		const configPath = writeConfig(
			JSON.stringify({
				gateway: {
					mode: "remote",
					remote: { url: "ws://10.0.0.5:18789/gw/" },
				},
			}),
		);
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe("http://10.0.0.5:18789/gw/readyz");
		expect(source.scope).toBe("remote");
	});

	test("remote mode + https url is used as-is host with readyz path", () => {
		const configPath = writeConfig(
			JSON.stringify({
				gateway: {
					mode: "remote",
					remote: { url: "https://hub.example.com:8443" },
				},
			}),
		);
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe("https://hub.example.com:8443/readyz");
		expect(source.scope).toBe("remote");
	});

	test("remote mode without remote.url → local fallback, detail explains why", () => {
		const configPath = writeConfig(
			JSON.stringify({ gateway: { mode: "remote" } }),
		);
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe(LOCAL_READYZ_URL);
		expect(source.scope).toBe("local");
		expect(source.detail).toContain("gateway.remote.url is missing");
	});

	test("remote mode with unparseable url → local fallback, detail explains why", () => {
		const configPath = writeConfig(
			JSON.stringify({
				gateway: { mode: "remote", remote: { url: "not a url" } },
			}),
		);
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe(LOCAL_READYZ_URL);
		expect(source.scope).toBe("local");
		expect(source.detail).toContain("not a usable");
	});

	test("remote mode with non-ws/http scheme → local fallback", () => {
		const configPath = writeConfig(
			JSON.stringify({
				gateway: { mode: "remote", remote: { url: "ftp://hub.example.com" } },
			}),
		);
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe(LOCAL_READYZ_URL);
		expect(source.scope).toBe("local");
	});

	test("query string and hash are stripped from the derived readyz url", () => {
		const configPath = writeConfig(
			JSON.stringify({
				gateway: {
					mode: "remote",
					remote: { url: "wss://hub.example.com/?token=abc#frag" },
				},
			}),
		);
		const source = resolveGatewayHealthSource(configPath);
		expect(source.readyzUrl).toBe("https://hub.example.com/readyz");
	});
});
