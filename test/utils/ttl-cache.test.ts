import { describe, expect, test } from "bun:test";
import { TtlCache } from "../../src/utils/ttl-cache.js";

describe("TtlCache", () => {
	test("getFresh returns a value only while within the TTL window", () => {
		const cache = new TtlCache<string>(5_000);
		cache.set("k", "v", 1_000);
		expect(cache.getFresh("k", 2_000)).toBe("v"); // 1s old < 5s TTL
		expect(cache.getFresh("k", 6_500)).toBeUndefined(); // 5.5s old > 5s TTL
		expect(cache.getFresh("missing", 2_000)).toBeUndefined();
	});

	test("getFresh treats exactly-TTL as expired (strict <)", () => {
		const cache = new TtlCache<number>(5_000);
		cache.setAt("k", 42, 0);
		expect(cache.getFresh("k", 4_999)).toBe(42);
		expect(cache.getFresh("k", 5_000)).toBeUndefined();
	});

	test("falsy values (false / null) are cached as real hits", () => {
		const cache = new TtlCache<boolean>(5_000);
		cache.set("k", false, 0);
		expect(cache.getFresh("k", 100)).toBe(false);
		expect(cache.has("k")).toBe(true);
	});

	test("delete / deleteWhere / clear remove entries", () => {
		const cache = new TtlCache<string>(5_000);
		cache.set("sock::a::w1", "x", 0);
		cache.set("sock::a::w2", "y", 0);
		cache.set("sock::b", "z", 0);
		cache.delete("sock::b");
		expect(cache.has("sock::b")).toBe(false);
		cache.deleteWhere((key) => key.includes("::a::"));
		expect(cache.size).toBe(0);
		cache.set("again", "1", 0);
		cache.clear();
		expect(cache.size).toBe(0);
	});
});
