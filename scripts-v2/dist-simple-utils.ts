export type ParsedReleaseVersion = {
	major: number;
	minor: number;
	patch: number;
	prerelease: string | null;
};

export function parseReleaseVersion(fileName: string): ParsedReleaseVersion | null {
	const match = fileName.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\.vsix$/);
	if (!match) return null;
	const [, major, minor, patch, prerelease] = match;
	if (!major || !minor || !patch) return null;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10),
		prerelease: prerelease ?? null,
	};
}

export function compareReleaseFileNames(a: string, b: string): number {
	const versionA = parseReleaseVersion(a);
	const versionB = parseReleaseVersion(b);
	if (!versionA || !versionB) {
		return b.localeCompare(a, undefined, { numeric: true });
	}

	const majorDiff = versionB.major - versionA.major;
	if (majorDiff !== 0) return majorDiff;

	const minorDiff = versionB.minor - versionA.minor;
	if (minorDiff !== 0) return minorDiff;

	const patchDiff = versionB.patch - versionA.patch;
	if (patchDiff !== 0) return patchDiff;

	const preA = versionA.prerelease;
	const preB = versionB.prerelease;
	if (preA === preB) return 0;
	if (preA === null) return -1;
	if (preB === null) return 1;
	return preB.localeCompare(preA, undefined, { numeric: true });
}

/**
 * Decide what a digest subprocess result means.
 *
 * Lives here, not in dist-simple.ts, so tests can import it without pulling in
 * that script's top-level `main()` call and starting a real distribution run.
 *
 * The digest is the release RECORD for a preview cut (CHANGELOG is curated for
 * stable GA), so "no digest" is never a silent success. This branch used to
 * swallow every failure: stderr was piped and never read, a non-zero exit wrote
 * nothing, and a bare catch discarded the error.
 */
export type DigestOutcome = { write: boolean; warnings: string[] };

export function evaluateDigestResult(
	version: string,
	exitCode: number | null,
	stdout: string,
	stderr: string,
): DigestOutcome {
	const digest = stdout.trim();
	const err = stderr.trim();
	const warnings: string[] = [];
	if (err) warnings.push(`   ⚠️  release-digest: ${err}`);
	if (digest && exitCode === 0) return { write: true, warnings };
	warnings.push(
		`\n⚠️  Release digest NOT written for v${version} (exit ${exitCode}${
			digest ? "" : ", empty output"
		}) — this cut has no release record.`,
	);
	return { write: false, warnings };
}
