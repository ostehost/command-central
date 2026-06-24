import { describe, expect, test } from "bun:test";
import { parseViewBoxDimensions } from "../../scripts/svg-to-png.ts";

const SCALE_FACTOR = 2;

/**
 * Regression coverage for PAR-60 / CP-19.
 *
 * The original viewBox regex only matched double-quoted, non-negative integer
 * values (`/viewBox="\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*"/`) and parsed the
 * dimensions with `Number.parseInt`. Valid SVGs using decimals, negative
 * origins, comma separators, or single quotes were rejected with
 * "No viewBox found". These cases all return non-null parsed dimensions now.
 */
describe("parseViewBoxDimensions (PAR-60 viewBox parsing)", () => {
	test("parses plain positive integers (existing behavior preserved)", () => {
		const result = parseViewBoxDimensions('<svg viewBox="0 0 100 80">');
		expect(result).toEqual({ width: 100, height: 80 });
	});

	test("accepts decimal width/height and reports 2x scaled dimensions", () => {
		const result = parseViewBoxDimensions('<svg viewBox="-0.5 0 100.5 80.25">');
		expect(result).not.toBeNull();
		expect(result).toEqual({ width: 100.5, height: 80.25 });

		// 2x scaling is what the converter reports for the produced PNG.
		const width = result?.width ?? 0;
		const height = result?.height ?? 0;
		expect(width * SCALE_FACTOR).toBe(201);
		expect(height * SCALE_FACTOR).toBe(160.5);
	});

	test("accepts a negative origin (first two values)", () => {
		const result = parseViewBoxDimensions('<svg viewBox="-10 -20 100 80">');
		expect(result).toEqual({ width: 100, height: 80 });
	});

	test("accepts comma-separated values", () => {
		const result = parseViewBoxDimensions('<svg viewBox="0, 0, 100, 80">');
		expect(result).toEqual({ width: 100, height: 80 });
	});

	test("accepts single-quoted attribute values", () => {
		const result = parseViewBoxDimensions("<svg viewBox='0 0 100 80'>");
		expect(result).toEqual({ width: 100, height: 80 });
	});

	test("accepts comma+decimal+single-quote combined", () => {
		const result = parseViewBoxDimensions("<svg viewBox='-0.5,0,100.5,80.25'>");
		expect(result).toEqual({ width: 100.5, height: 80.25 });
	});

	test("returns null when no viewBox is present", () => {
		expect(parseViewBoxDimensions('<svg width="100" height="80">')).toBeNull();
	});
});
