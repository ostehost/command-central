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
	// Registry icons, keyed by resolved path. Reparsed only when the file's
	// mtime or location changes — see readRegistryIcon.
	private registryIcons: Map<string, string> | null = null;
	private registryPath: string | null = null;
	private registryMtime = 0;

	/**
	 * Resolve a project's icon. NEVER writes.
	 *
	 * This used to be `ensureProjectIconPersisted` and it persisted whatever it
	 * resolved — including a hash-derived icon picked from PROJECT_ICON_POOL when
	 * the project had none configured. That made a read stamp an arbitrary emoji
	 * into ANOTHER repository's tracked `.vscode/settings.json` (creating
	 * `.vscode/` if absent), which is how most of the workspace ended up with
	 * icons that disagree with Linear. Only `setCustomIcon` — an explicit user
	 * action — is allowed to write.
	 */
	async resolveProjectIcon(projectDir: string): Promise<string> {
		return this.getIconForProject(projectDir);
	}

	/**
	 * Precedence: work registry (populated from Linear, the authoring surface)
	 * -> `.vscode/settings.json` local override -> deterministic fallback.
	 *
	 * The registry wins because it is the only store that is reconciled across
	 * every consumer (this extension, the ghostty-launcher bundle build, and the
	 * partner dashboard). The settings key stays as the local escape hatch for a
	 * project that is not in the registry, or that wants to differ from it.
	 *
	 * The deterministic fallback is display-only. It is a stable per-directory
	 * choice so the tree does not flicker, but it is never persisted.
	 */
	getIconForProject(projectDir: string): string {
		if (!projectDir) return DEFAULT_ICON;

		const cached = this.iconCache.get(projectDir);
		if (cached) return cached;

		const registryIcon = this.readRegistryIcon(projectDir);
		if (registryIcon) {
			this.iconCache.set(projectDir, registryIcon);
			return registryIcon;
		}

		const configured = this.readConfiguredIcon(projectDir);
		if (configured) {
			this.iconCache.set(projectDir, configured);
			return configured;
		}

		const generated = this.generateDeterministicIcon(projectDir);
		this.iconCache.set(projectDir, generated);
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

	/**
	 * Candidate locations for the work registry, in precedence order.
	 *
	 * Never hardcode an absolute `/Users/<name>` path here. The config repo is
	 * deployed as the user's config home (cloned to ~/.config), so the XDG
	 * location is the canonical username-independent answer; the ~/projects
	 * checkout is the fallback for workspaces that keep it there. A hardcoded
	 * home broke every spawn on the second Mac once already.
	 */
	private registryCandidates(): string[] {
		const candidates: string[] = [];
		const explicit = process.env["PROJECTS_WORK_REGISTRY"];
		if (explicit) candidates.push(explicit);

		const rel = path.join("openclaw", "conductor", "work-registry.json");
		const openclawHome = process.env["OPENCLAW_CONFIG_HOME"];
		if (openclawHome) candidates.push(path.join(openclawHome, rel));

		const xdg = process.env["XDG_CONFIG_HOME"];
		const home = process.env["HOME"] ?? "";
		candidates.push(path.join(xdg || path.join(home, ".config"), rel));
		candidates.push(path.join(home, "projects", "config", rel));
		return candidates;
	}

	/**
	 * Look up this directory's icon in the work registry.
	 *
	 * Matching is on the registry row's own `paths` values (hub/node) only —
	 * deliberately not on directory basename. Basename matching would misfile the
	 * dated worktree directories that share a parent repo's name. A miss returns
	 * null and the caller falls through to the settings key.
	 *
	 * Parsed at most once per registry mtime: this is called for every row on
	 * every tree render.
	 */
	private readRegistryIcon(projectDir: string): string | null {
		const registryPath = this.registryCandidates().find((candidate) =>
			fs.existsSync(candidate),
		);
		if (!registryPath) return null;

		try {
			const mtime = fs.statSync(registryPath).mtimeMs;
			if (
				!this.registryIcons ||
				this.registryPath !== registryPath ||
				this.registryMtime !== mtime
			) {
				this.registryIcons = this.parseRegistryIcons(registryPath);
				this.registryPath = registryPath;
				this.registryMtime = mtime;
			}
		} catch {
			return null;
		}

		const resolved = this.realPathOrSelf(projectDir);
		return this.registryIcons?.get(resolved) ?? null;
	}

	private parseRegistryIcons(registryPath: string): Map<string, string> {
		const byPath = new Map<string, string>();
		try {
			const parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
				projects?: Array<{
					icon?: unknown;
					paths?: Record<string, unknown>;
				}>;
			};
			for (const project of parsed.projects ?? []) {
				const icon =
					typeof project.icon === "string" ? project.icon.trim() : "";
				if (!icon) continue;
				for (const value of Object.values(project.paths ?? {})) {
					if (typeof value !== "string" || !value) continue;
					byPath.set(this.realPathOrSelf(value), icon);
				}
			}
		} catch {
			// Unreadable or malformed registry: fall through to the settings key.
		}
		return byPath;
	}

	private realPathOrSelf(target: string): string {
		try {
			return fs.realpathSync(target);
		} catch {
			// The registry lists paths for every host, so most will not exist here.
			return path.resolve(target);
		}
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
