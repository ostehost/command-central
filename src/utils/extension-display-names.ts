/**
 * Maps file extensions to human-readable display names
 */

/**
 * Database of known file extensions and their display names
 */
const EXTENSION_DISPLAY_NAMES = new Map<string, string>([
	// Programming Languages (15)
	[".ts", "TypeScript"],
	[".tsx", "TypeScript React"],
	[".js", "JavaScript"],
	[".jsx", "JavaScript React"],
	[".py", "Python"],
	[".java", "Java"],
	[".cpp", "C++"],
	[".c", "C"],
	[".cs", "C#"],
	[".go", "Go"],
	[".rs", "Rust"],
	[".swift", "Swift"],
	[".kt", "Kotlin"],
	[".rb", "Ruby"],
	[".php", "PHP"],

	// Configuration (7)
	[".json", "JSON"],
	[".yaml", "YAML"],
	[".yml", "YAML"],
	[".toml", "TOML"],
	[".ini", "INI"],
	[".env", "Environment"],
	[".xml", "XML"],

	// Documentation (4)
	[".md", "Markdown"],
	[".txt", "Text"],
	[".rst", "reStructuredText"],
	[".pdf", "PDF"],

	// Images (7)
	[".png", "PNG Image"],
	[".jpg", "JPEG Image"],
	[".jpeg", "JPEG Image"],
	[".gif", "GIF Image"],
	[".svg", "SVG Image"],
	[".ico", "Icon"],
	[".webp", "WebP Image"],

	// Web (5)
	[".html", "HTML"],
	[".css", "CSS"],
	[".scss", "SCSS"],
	[".sass", "Sass"],
	[".less", "Less"],

	// Data (2)
	[".csv", "CSV"],
	[".sql", "SQL"],

	// Shell (3)
	[".sh", "Shell Script"],
	[".bash", "Bash Script"],
	[".zsh", "Zsh Script"],
]);

/**
 * Gets a human-readable display name for a file extension
 *
 * @param extension - File extension (with or without leading dot)
 * @returns Human-readable name (e.g., "TypeScript", "Markdown")
 *
 * @example
 * ```ts
 * getDisplayName(".ts")    // "TypeScript"
 * getDisplayName("ts")     // "TypeScript"
 * getDisplayName(".xyz")   // "XYZ"
 * getDisplayName("")       // "No Extension"
 * ```
 */
export function getDisplayName(extension: string): string {
	// Handle empty extension
	if (extension === "") {
		return "No Extension";
	}

	// Normalize: ensure leading dot and lowercase
	const normalized = extension.toLowerCase().startsWith(".")
		? extension.toLowerCase()
		: `.${extension.toLowerCase()}`;

	// Look up known extension
	const displayName = EXTENSION_DISPLAY_NAMES.get(normalized);
	if (displayName) {
		return displayName;
	}

	// Unknown extension: return uppercase without dot
	return normalized.slice(1).toUpperCase();
}
