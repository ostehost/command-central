import { describe, expect, test } from "bun:test";
import {
	getAppPath,
	slugify,
} from "../../src/terminal/app-bundle-generator.js";

describe("app-bundle-generator", () => {
	test("slugify simple name", () => {
		expect(slugify("My API")).toBe("my-api");
	});

	test("slugify with special chars", () => {
		expect(slugify("Hello World! 123")).toBe("hello-world-123");
	});

	test("slugify strips leading/trailing dashes", () => {
		expect(slugify("--test--")).toBe("test");
	});

	test("getAppPath returns correct path", () => {
		const result = getAppPath("My Project");
		expect(result).toContain("Applications/CommandCentral/My Project.app");
	});
});
