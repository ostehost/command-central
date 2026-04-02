#!/usr/bin/env bun
/**
 * release-digest.ts — Generate a partnership-facing release digest
 *
 * Reads the CHANGELOG.md, extracts the latest version section, and formats
 * it as a concise, excitement-worthy summary suitable for Discord/chat delivery.
 *
 * Usage:
 *   bun run scripts-v2/release-digest.ts [--version v0.5.1-49] [--format discord|markdown|plain]
 *
 * Output: formatted digest to stdout
 */

import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const versionArg = args.find((a) => a.startsWith("--version="))?.split("=")[1]
	?? (args.includes("--version") ? args[args.indexOf("--version") + 1] : undefined);
const formatArg = args.find((a) => a.startsWith("--format="))?.split("=")[1]
	?? (args.includes("--format") ? args[args.indexOf("--format") + 1] : "discord");

const projectRoot = path.resolve(import.meta.dir, "..");
const changelogPath = path.join(projectRoot, "CHANGELOG.md");
const packagePath = path.join(projectRoot, "package.json");

if (!fs.existsSync(changelogPath)) {
	console.error("CHANGELOG.md not found");
	process.exit(1);
}

const changelog = fs.readFileSync(changelogPath, "utf-8");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
const currentVersion = `v${pkg.version}`;

// Extract version sections
const versionRegex = /^## \[([^\]]+)\]/gm;
const sections: { version: string; start: number; end: number; content: string }[] = [];
let match: RegExpExecArray | null;

while ((match = versionRegex.exec(changelog)) !== null) {
	if (sections.length > 0) {
		sections[sections.length - 1].end = match.index;
		sections[sections.length - 1].content = changelog.slice(
			sections[sections.length - 1].start,
			match.index,
		).trim();
	}
	sections.push({
		version: match[1],
		start: match.index,
		end: changelog.length,
		content: "",
	});
}
if (sections.length > 0) {
	sections[sections.length - 1].content = changelog
		.slice(sections[sections.length - 1].start)
		.trim();
}

// Find target version(s)
const targetVersion = versionArg?.replace(/^v/, "") ?? sections[0]?.version;
if (!targetVersion) {
	console.error("No versions found in CHANGELOG.md");
	process.exit(1);
}

const targetSection = sections.find((s) => s.version === targetVersion);
if (!targetSection) {
	console.error(`Version ${targetVersion} not found in CHANGELOG.md`);
	console.error(`Available: ${sections.map((s) => s.version).join(", ")}`);
	process.exit(1);
}

// Parse the section into categories
function parseSection(content: string): Map<string, string[]> {
	const categories = new Map<string, string[]>();
	let currentCategory = "";

	for (const line of content.split("\n")) {
		const categoryMatch = line.match(/^### (.+)/);
		if (categoryMatch) {
			currentCategory = categoryMatch[1];
			categories.set(currentCategory, []);
			continue;
		}

		const itemMatch = line.match(/^- \*\*(.+?)\*\*\s*[—–-]\s*(.+)/);
		if (itemMatch && currentCategory) {
			const items = categories.get(currentCategory) ?? [];
			items.push(`**${itemMatch[1]}** — ${itemMatch[2]}`);
			categories.set(currentCategory, items);
		}
	}

	return categories;
}

const categories = parseSection(targetSection.content);

// Format output
function formatDiscord(): string {
	const lines: string[] = [];
	lines.push(`## 🚀 Command Central ${currentVersion}`);
	lines.push("");

	const emojiMap: Record<string, string> = {
		Added: "✨",
		Changed: "⚡",
		Fixed: "🔧",
		Removed: "🗑️",
		Deprecated: "⚠️",
		Security: "🔒",
	};

	for (const [category, items] of categories) {
		const emoji = emojiMap[category] ?? "📋";
		lines.push(`${emoji} **${category}**`);
		for (const item of items) {
			lines.push(`  • ${item}`);
		}
		lines.push("");
	}

	// Add a highlight if there are performance items
	const allItems = [...categories.values()].flat().join(" ").toLowerCase();
	if (allItems.includes("faster") || allItems.includes("performance") || allItems.includes("optimiz")) {
		lines.push("⚡ *Performance improvements in this release*");
		lines.push("");
	}

	return lines.join("\n").trim();
}

function formatMarkdown(): string {
	return targetSection.content;
}

function formatPlain(): string {
	const lines: string[] = [];
	lines.push(`Command Central ${currentVersion}`);
	lines.push("=".repeat(40));

	for (const [category, items] of categories) {
		lines.push(`\n${category}:`);
		for (const item of items) {
			lines.push(`  - ${item.replace(/\*\*/g, "")}`);
		}
	}

	return lines.join("\n").trim();
}

switch (formatArg) {
	case "discord":
		console.log(formatDiscord());
		break;
	case "markdown":
		console.log(formatMarkdown());
		break;
	case "plain":
		console.log(formatPlain());
		break;
	default:
		console.error(`Unknown format: ${formatArg}`);
		process.exit(1);
}
