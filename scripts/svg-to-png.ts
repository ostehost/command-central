#!/usr/bin/env bun

/**
 * SVG → PNG converter using Playwright (Chromium)
 *
 * Why Playwright? Only a real browser engine renders Apple Color Emoji.
 * Standalone rasterizers (resvg, cairo, sharp/librsvg) all produce
 * monochrome glyphs or tofu for emoji characters.
 *
 * Usage:
 *   bun run scripts/svg-to-png.ts                    # Convert all marketing SVGs
 *   bun run scripts/svg-to-png.ts site/assets/hero.svg  # Convert one file
 *
 * Output: PNG at 2x resolution alongside the source SVG (hero.svg → hero.png)
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";

const SCALE_FACTOR = 2;

// Default SVGs to convert when no args provided
const DEFAULT_SVGS = [
	"site/assets/hero.svg",
	"site/assets/git-status.svg",
	"site/assets/filter.svg",
];

async function main() {
	const args = process.argv.slice(2);
	const svgPaths = args.length > 0 ? args : DEFAULT_SVGS;

	// Parse all SVGs first
	const jobs = [];
	for (const svgPath of svgPaths) {
		const absPath = resolve(svgPath);
		if (!existsSync(absPath)) {
			console.error(`❌ Not found: ${svgPath}`);
			process.exit(1);
		}

		const svgContent = readFileSync(absPath, "utf-8");
		const viewBoxMatch = svgContent.match(
			/viewBox="\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*"/,
		);
		if (!viewBoxMatch) {
			console.error(`❌ No viewBox found in ${svgPath}`);
			process.exit(1);
		}

		const svgWidth = Number.parseInt(viewBoxMatch[3], 10);
		const svgHeight = Number.parseInt(viewBoxMatch[4], 10);
		const pngName = `${basename(svgPath, ".svg")}.png`;
		const pngPath = join(dirname(absPath), pngName);

		jobs.push({ svgPath, svgContent, svgWidth, svgHeight, pngPath, pngName });
	}

	// Launch browser once, reuse for all conversions
	console.log(
		`🎨 Converting ${jobs.length} SVG(s) to PNG at ${SCALE_FACTOR}x...`,
	);
	const browser = await chromium.launch();

	for (const job of jobs) {
		const page = await browser.newPage({
			deviceScaleFactor: SCALE_FACTOR,
			viewport: { width: job.svgWidth, height: job.svgHeight },
		});

		// Inject SVG with explicit dimensions to ensure visibility
		const sizedSvg = job.svgContent.replace(
			/<svg/,
			`<svg width="${job.svgWidth}" height="${job.svgHeight}"`,
		);

		await page.setContent(`
			<html>
			<head><style>
				* { margin: 0; padding: 0; }
				body { overflow: hidden; }
			</style></head>
			<body>${sizedSvg}</body>
			</html>
		`);

		// Screenshot the full page (viewport matches SVG dimensions exactly)
		await page.screenshot({
			path: job.pngPath,
		});

		const expectedWidth = job.svgWidth * SCALE_FACTOR;
		const expectedHeight = job.svgHeight * SCALE_FACTOR;
		console.log(`  ✅ ${job.pngName} (${expectedWidth}×${expectedHeight})`);

		await page.close();
	}

	await browser.close();
	console.log("Done.");
}

main().catch((err) => {
	console.error("❌ Fatal:", err.message);
	process.exit(1);
});
