import { beforeEach, describe, expect, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

let execFileSyncCalls: Array<{ cmd: string; args: string[] }> = [];
let execFileSyncResult: Buffer | string | Error = "";
let readFileSyncCalls: string[] = [];
let readFileSyncResult: Buffer | string | Error = "";

setupVSCodeMock();

const { BINARY_FILE_PLACEHOLDER, DiffContentProvider } = await import(
	"../../src/providers/diff-content-provider.js"
);

type DiffUri = Parameters<
	InstanceType<typeof DiffContentProvider>["provideTextDocumentContent"]
>[0];

function createDiffUri(path: string, query: string): DiffUri {
	return {
		scheme: "cc-diff",
		authority: "",
		path,
		query,
		fragment: "",
		fsPath: path,
		with: () => createDiffUri(path, query),
		toString: () => `cc-diff:${path}?${query}`,
	} as unknown as DiffUri;
}

function createProvider() {
	return new DiffContentProvider({
		execFileSync: ((cmd: string, argsOrOptions?: unknown) => {
			const args = Array.isArray(argsOrOptions)
				? argsOrOptions.filter(
						(value): value is string => typeof value === "string",
					)
				: [];
			execFileSyncCalls.push({ cmd, args });
			if (execFileSyncResult instanceof Error) throw execFileSyncResult;
			return execFileSyncResult;
		}) as never,
		readFileSync: ((filePath: unknown) => {
			if (typeof filePath !== "string") {
				throw new Error("Expected string file path");
			}
			readFileSyncCalls.push(filePath);
			if (readFileSyncResult instanceof Error) throw readFileSyncResult;
			return readFileSyncResult;
		}) as never,
		join: ((...parts: string[]) =>
			parts.join("/").replace(/\/+/g, "/")) as never,
	});
}

describe("DiffContentProvider", () => {
	beforeEach(() => {
		execFileSyncCalls = [];
		execFileSyncResult = "";
		readFileSyncCalls = [];
		readFileSyncResult = "";
	});

	test("returns empty string for ref=empty", () => {
		const provider = createProvider();

		const content = provider.provideTextDocumentContent(
			createDiffUri(
				"/src/app.ts",
				"project=%2Ftmp%2Fproject&ref=empty&taskId=task-1",
			),
		);

		expect(content).toBe("");
		expect(execFileSyncCalls).toHaveLength(0);
		expect(readFileSyncCalls).toHaveLength(0);
	});

	test("reads working tree content when ref=working-tree", () => {
		readFileSyncResult = "export const answer = 42;\n";
		const provider = createProvider();

		const content = provider.provideTextDocumentContent(
			createDiffUri(
				"/src/app.ts",
				"project=%2Ftmp%2Fproject&ref=working-tree&taskId=task-1",
			),
		);

		expect(content).toBe("export const answer = 42;\n");
		expect(readFileSyncCalls).toEqual(["/tmp/project/src/app.ts"]);
		expect(execFileSyncCalls).toHaveLength(0);
	});

	test("calls git show for commit refs", () => {
		execFileSyncResult = "console.log('hello');\n";
		const provider = createProvider();

		const content = provider.provideTextDocumentContent(
			createDiffUri(
				"/src/app.ts",
				"project=%2Ftmp%2Fproject&ref=abc123&taskId=task-1",
			),
		);

		expect(content).toBe("console.log('hello');\n");
		expect(execFileSyncCalls).toEqual([
			{
				cmd: "git",
				args: ["-C", "/tmp/project", "show", "abc123:src/app.ts"],
			},
		]);
	});

	test("returns empty string on git errors", () => {
		execFileSyncResult = new Error("bad revision");
		const provider = createProvider();

		const content = provider.provideTextDocumentContent(
			createDiffUri(
				"/src/missing.ts",
				"project=%2Ftmp%2Fproject&ref=abc123&taskId=task-1",
			),
		);

		expect(content).toBe("");
	});

	test("returns binary placeholder for binary git content", () => {
		execFileSyncResult = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
		const provider = createProvider();

		const content = provider.provideTextDocumentContent(
			createDiffUri(
				"/assets/logo.png",
				"project=%2Ftmp%2Fproject&ref=abc123&taskId=task-1",
			),
		);

		expect(content).toBe(BINARY_FILE_PLACEHOLDER);
	});
});
