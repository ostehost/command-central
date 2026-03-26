import * as fs from "node:fs";
import * as path from "node:path";

type SettingsDocument = Record<string, unknown>;

type FormattingHints = {
	indent: number | string;
	eol: "\n" | "\r\n";
};

const DEFAULT_ICON = "📁";

const PROJECT_ICON_POOL = [
	"🚀",
	"🧠",
	"⚙️",
	"🛠️",
	"📦",
	"🧪",
	"🔧",
	"🧩",
	"🧰",
	"🖥️",
	"💾",
	"🗄️",
	"📡",
	"🛰️",
	"📊",
	"📈",
	"🔬",
	"🧬",
	"🔒",
	"🛡️",
	"📁",
	"🗂️",
	"📝",
	"📚",
	"🎯",
	"🎨",
	"🎮",
	"🎬",
	"🎵",
	"🧭",
	"⚡",
	"🔥",
	"🌊",
	"☀️",
	"🌙",
	"⭐",
	"☁️",
	"🌈",
	"🏔️",
	"🌱",
	"🌲",
	"🌿",
	"🍃",
	"🪴",
	"🪵",
	"🧱",
	"🧵",
	"🪄",
	"🧲",
	"🧊",
	"🛞",
	"🕹️",
	"🧯",
	"📎",
	"📌",
	"🔋",
];

export class ProjectIconManager {
	private iconCache = new Map<string, string>();
	private writeQueue = new Map<string, Promise<void>>();

	getIconForProject(projectDir: string): string {
		if (!projectDir) return DEFAULT_ICON;

		const cached = this.iconCache.get(projectDir);
		if (cached) return cached;

		const configured = this.readConfiguredIcon(projectDir);
		if (configured) {
			this.iconCache.set(projectDir, configured);
			return configured;
		}

		const generated = this.generateDeterministicIcon(projectDir);
		this.iconCache.set(projectDir, generated);
		void this.queueWrite(projectDir, generated);
		return generated;
	}

	async setCustomIcon(projectDir: string, icon: string): Promise<void> {
		if (!projectDir) return;
		const normalized = icon.trim();
		if (!normalized) return;
		this.iconCache.set(projectDir, normalized);
		await this.queueWrite(projectDir, normalized);
	}

	private getSettingsPath(projectDir: string): string {
		return path.join(projectDir, ".vscode", "settings.json");
	}

	private readConfiguredIcon(projectDir: string): string | null {
		const settingsPath = this.getSettingsPath(projectDir);
		if (!fs.existsSync(settingsPath)) return null;

		try {
			const raw = fs.readFileSync(settingsPath, "utf-8");
			const parsed = JSON.parse(raw) as SettingsDocument;
			const icon = parsed["commandCentral.project.icon"];
			if (typeof icon !== "string") return null;
			const normalized = icon.trim();
			return normalized.length > 0 ? normalized : null;
		} catch {
			return null;
		}
	}

	private queueWrite(projectDir: string, icon: string): Promise<void> {
		const existing = this.writeQueue.get(projectDir) ?? Promise.resolve();
		const next = existing
			.catch(() => {
				// Ignore previous write failures; continue with latest icon write.
			})
			.then(() => this.writeIconToSettings(projectDir, icon));
		this.writeQueue.set(projectDir, next);
		return next.finally(() => {
			const current = this.writeQueue.get(projectDir);
			if (current === next) {
				this.writeQueue.delete(projectDir);
			}
		});
	}

	private async writeIconToSettings(
		projectDir: string,
		icon: string,
	): Promise<void> {
		const settingsPath = this.getSettingsPath(projectDir);

		try {
			const { settings, formatting } = this.readSettingsDocument(settingsPath);
			settings["commandCentral.project.icon"] = icon;

			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			const serialized = JSON.stringify(settings, null, formatting.indent);
			const content = `${serialized.replaceAll("\n", formatting.eol)}${formatting.eol}`;
			await fs.promises.writeFile(settingsPath, content, "utf-8");
		} catch {
			// Best-effort persistence only (should never block tree rendering).
		}
	}

	private readSettingsDocument(settingsPath: string): {
		settings: SettingsDocument;
		formatting: FormattingHints;
	} {
		if (!fs.existsSync(settingsPath)) {
			return {
				settings: {},
				formatting: { indent: 2, eol: "\n" },
			};
		}

		try {
			const raw = fs.readFileSync(settingsPath, "utf-8");
			const parsed = JSON.parse(raw);
			const settings =
				parsed && typeof parsed === "object" && !Array.isArray(parsed)
					? (parsed as SettingsDocument)
					: {};
			return {
				settings,
				formatting: this.detectFormatting(raw),
			};
		} catch {
			// If existing file is malformed, avoid clobbering it.
			throw new Error("Malformed settings.json");
		}
	}

	private detectFormatting(raw: string): FormattingHints {
		const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n";
		const indentMatch = raw.match(/\n([ \t]+)"[^"\n]+"\s*:/);
		const indent = indentMatch?.[1] ?? 2;
		return { indent, eol };
	}

	private generateDeterministicIcon(projectDir: string): string {
		const baseName = path.basename(projectDir).toLowerCase().trim();
		if (!baseName) return DEFAULT_ICON;

		const hash = this.fnv1aHash(baseName);
		const index = hash % PROJECT_ICON_POOL.length;
		return PROJECT_ICON_POOL[index] ?? DEFAULT_ICON;
	}

	private fnv1aHash(input: string): number {
		let hash = 0x811c9dc5;
		for (const char of input) {
			hash ^= char.codePointAt(0) ?? 0;
			hash = Math.imul(hash, 0x01000193);
		}
		return hash >>> 0;
	}
}
