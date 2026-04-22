import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

type PackageJsonShape = {
	activationEvents?: string[];
	contributes?: {
		commands?: Array<{ command?: string }>;
	};
	engines?: {
		vscode?: string;
	};
};

type SourceFile = {
	path: string;
	text: string;
};

const repoRoot = path.resolve(import.meta.dir, "../..");
const packageJsonPath = path.join(repoRoot, "package.json");
const srcRoot = path.join(repoRoot, "src");
const projectViewManagerPath = path.join(
	srcRoot,
	"services",
	"project-view-manager.ts",
);

const allowedActivationEventPatterns = [
	/^onStartupFinished$/,
	/^onCommand:.+/,
	/^onView:.+/,
	/^workspaceContains:.+/,
	/^onLanguage:.+/,
	/^onFileSystem:.+/,
	/^onUri$/,
	/^onWebviewPanel:.+/,
	/^onNotebook:.+/,
	/^onTerminal:.+/,
];

function walkSourceFiles(dir: string): string[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	return entries.flatMap((entry) => {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return walkSourceFiles(entryPath);
		}
		return /\.(ts|tsx|js|jsx)$/.test(entry.name) ? [entryPath] : [];
	});
}

function readPackageJson(): PackageJsonShape {
	return JSON.parse(
		fs.readFileSync(packageJsonPath, "utf8"),
	) as PackageJsonShape;
}

function readSourceFiles(): SourceFile[] {
	return walkSourceFiles(srcRoot).map((filePath) => ({
		path: filePath,
		text: fs.readFileSync(filePath, "utf8"),
	}));
}

function getManifestCommandIds(): string[] {
	return (readPackageJson().contributes?.commands ?? [])
		.map((item) => item.command)
		.filter((command): command is string => Boolean(command));
}

function extractLiteralPublicCommandIds(sourceFiles: SourceFile[]): string[] {
	const patterns = [
		/register(?:TextEditor)?Command\(\s*["'`](commandCentral\.[^"'`]+)["'`]/g,
		/executeCommand\(\s*["'`](commandCentral\.[^"'`]+)["'`]/g,
		/\bcommand:\s*["'`](commandCentral\.[^"'`]+)["'`]/g,
	];

	const commandIds = new Set<string>();
	for (const sourceFile of sourceFiles) {
		for (const pattern of patterns) {
			let match: RegExpExecArray | null;
			while ((match = pattern.exec(sourceFile.text)) !== null) {
				const [, commandId] = match;
				if (!commandId || commandId.includes("${")) {
					continue;
				}
				commandIds.add(commandId);
			}
			pattern.lastIndex = 0;
		}
	}

	return [...commandIds].sort();
}

function hasGeneratedSlotCommandImplementation(
	commandId: string,
	projectViewManagerSource: string,
): boolean {
	const match = commandId.match(
		/^commandCentral\.gitSort\.(refreshView|changeSortOrder|changeFileFilter)\.slot\d+(Panel)?$/,
	);
	if (!match) {
		return false;
	}

	const [, commandName, panelSuffix] = match;
	const template = panelSuffix
		? `commandCentral.gitSort.${commandName}.\${slotId}Panel`
		: `commandCentral.gitSort.${commandName}.\${slotId}`;
	return projectViewManagerSource.includes(template);
}

function hasCommandImplementation(
	commandId: string,
	sourceFiles: SourceFile[],
	projectViewManagerSource: string,
): boolean {
	if (sourceFiles.some((sourceFile) => sourceFile.text.includes(commandId))) {
		return true;
	}

	return hasGeneratedSlotCommandImplementation(
		commandId,
		projectViewManagerSource,
	);
}

describe("package.json manifest contract", () => {
	test("defines required manifest surfaces", () => {
		const packageJson = readPackageJson();
		expect(packageJson.contributes?.commands).toBeDefined();
		expect(packageJson.activationEvents).toBeDefined();
		expect(packageJson.engines?.vscode).toBeDefined();
	});

	test("every literal public command reference is contributed", () => {
		const sourceFiles = readSourceFiles();
		const manifestCommands = new Set(getManifestCommandIds());
		const literalCommandIds = extractLiteralPublicCommandIds(sourceFiles);
		const missingCommands = literalCommandIds.filter(
			(commandId) => !manifestCommands.has(commandId),
		);

		if (missingCommands.length > 0) {
			throw new Error(
				[
					"Commands referenced in source but missing from package.json contributes.commands:",
					...missingCommands.map((commandId) => `- ${commandId}`),
				].join("\n"),
			);
		}

		expect(missingCommands).toHaveLength(0);
	});

	test("every contributed command has an implementation in src", () => {
		const sourceFiles = readSourceFiles();
		const projectViewManagerSource = fs.readFileSync(
			projectViewManagerPath,
			"utf8",
		);
		const missingImplementations = getManifestCommandIds().filter(
			(commandId) =>
				!hasCommandImplementation(
					commandId,
					sourceFiles,
					projectViewManagerSource,
				),
		);

		if (missingImplementations.length > 0) {
			throw new Error(
				[
					"Manifest commands without an implementation in src/:",
					...missingImplementations.map((commandId) => `- ${commandId}`),
				].join("\n"),
			);
		}

		expect(missingImplementations).toHaveLength(0);
	});

	test("activation events use known VS Code forms", () => {
		const invalidActivationEvents = (
			readPackageJson().activationEvents ?? []
		).filter(
			(event) =>
				!allowedActivationEventPatterns.some((pattern) => pattern.test(event)),
		);

		if (invalidActivationEvents.length > 0) {
			throw new Error(
				[
					"Activation events use unknown forms:",
					...invalidActivationEvents.map((event) => `- ${event}`),
				].join("\n"),
			);
		}

		expect(invalidActivationEvents).toHaveLength(0);
	});
});
