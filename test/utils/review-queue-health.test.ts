import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type * as _fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const realFs = (globalThis as Record<string, unknown>)[
	"__realNodeFs"
] as typeof _fs;

const statSyncMock = mock((...args: unknown[]) =>
	(realFs.statSync as unknown as (...a: unknown[]) => unknown)(...args),
);

mock.module("node:fs", () => ({
	...realFs,
	statSync: statSyncMock,
}));

const { checkAdvertisedReviewQueue } = await import(
	"../../src/utils/review-queue-health.js"
);

const tmpDirs: string[] = [];
function makeTmp(): string {
	const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "review-queue-"));
	tmpDirs.push(dir);
	return dir;
}

describe("checkAdvertisedReviewQueue", () => {
	beforeEach(() => {
		mock.module("node:fs", () => ({
			...realFs,
			statSync: statSyncMock,
		}));
		statSyncMock.mockImplementation((...args: unknown[]) =>
			(realFs.statSync as unknown as (...a: unknown[]) => unknown)(...args),
		);
	});

	afterAll(() => {
		for (const dir of tmpDirs) {
			try {
				realFs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	test("missing declaration is absent", () => {
		const dir = makeTmp();
		expect(
			checkAdvertisedReviewQueue({
				project_dir: dir,
				pending_review_path: null,
			}),
		).toBe("absent");
		expect(
			checkAdvertisedReviewQueue({ project_dir: dir, pending_review_path: "" }),
		).toBe("absent");
		expect(
			checkAdvertisedReviewQueue({
				project_dir: dir,
				pending_review_path: " \n\t",
			}),
		).toBe("absent");
	});

	test("absolute receipt path present or missing", () => {
		const dir = makeTmp();
		const present = path.join(dir, "receipt.json");
		realFs.writeFileSync(present, "{}\n");
		expect(
			checkAdvertisedReviewQueue({
				project_dir: "/unused",
				pending_review_path: present,
			}),
		).toBe("present");
		expect(
			checkAdvertisedReviewQueue({
				project_dir: "/unused",
				pending_review_path: path.join(dir, "missing.json"),
			}),
		).toBe("missing");
	});

	test("relative receipt path is project scoped", () => {
		const dir = makeTmp();
		realFs.writeFileSync(path.join(dir, "queue.json"), "{}\n");
		expect(
			checkAdvertisedReviewQueue({
				project_dir: dir,
				pending_review_path: "queue.json",
			}),
		).toBe("present");
		expect(
			checkAdvertisedReviewQueue({
				project_dir: dir,
				pending_review_path: "not-here.json",
			}),
		).toBe("missing");
		expect(
			checkAdvertisedReviewQueue({
				project_dir: dir,
				pending_review_path: "../escape.json",
			}),
		).toBe("unknown");
	});

	test("directory at receipt path is missing", () => {
		const dir = makeTmp();
		realFs.mkdirSync(path.join(dir, "queue-dir"));
		expect(
			checkAdvertisedReviewQueue({
				project_dir: dir,
				pending_review_path: "queue-dir",
			}),
		).toBe("missing");
	});

	test("non-ENOENT stat failures are unknown", () => {
		const dir = makeTmp();
		realFs.writeFileSync(path.join(dir, "receipt.json"), "{}\n");
		statSyncMock.mockImplementation(() => {
			throw Object.assign(new Error("permission denied"), {
				code: "EACCES",
			});
		});
		expect(
			checkAdvertisedReviewQueue({
				project_dir: dir,
				pending_review_path: "receipt.json",
			}),
		).toBe("unknown");
	});
});
