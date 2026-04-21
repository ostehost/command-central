import { describe, expect, test } from "bun:test";
import {
	compareReleaseFileNames,
	parseReleaseVersion,
} from "../../scripts-v2/dist-simple-utils.ts";

describe("dist-simple release ordering", () => {
	test("parses rc prerelease filenames", () => {
		expect(parseReleaseVersion("command-central-0.6.0-rc.10.vsix")).toEqual({
			major: 0,
			minor: 6,
			patch: 0,
			prerelease: "rc.10",
		});
	});

	test("sorts rc.10 ahead of rc.9", () => {
		const files = [
			"command-central-0.6.0-rc.9.vsix",
			"command-central-0.6.0-rc.10.vsix",
			"command-central-0.6.0-rc.8.vsix",
		].sort(compareReleaseFileNames);
		expect(files).toEqual([
			"command-central-0.6.0-rc.10.vsix",
			"command-central-0.6.0-rc.9.vsix",
			"command-central-0.6.0-rc.8.vsix",
		]);
	});

	test("keeps stable newer than same-core prerelease", () => {
		const files = [
			"command-central-0.6.0.vsix",
			"command-central-0.6.0-rc.10.vsix",
		].sort(compareReleaseFileNames);
		expect(files).toEqual([
			"command-central-0.6.0.vsix",
			"command-central-0.6.0-rc.10.vsix",
		]);
	});
});
