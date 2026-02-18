/**
 * Performance Test Helper
 *
 * Utilities for performance testing, benchmarking, and cache effectiveness measurement.
 * Ensures performance targets are met and locked in by tests.
 */

/**
 * Performance measurement result
 */
export interface PerformanceResult<T> {
	elapsed: number;
	passed: boolean;
	result: T;
	details?: string;
}

/**
 * Cache statistics
 */
export interface CacheStats {
	hits: number;
	misses: number;
	total: number;
	hitRate: number;
}

/**
 * Performance benchmark result
 */
export interface BenchmarkResult {
	name: string;
	iterations: number;
	totalMs: number;
	avgMs: number;
	minMs: number;
	maxMs: number;
	passed: boolean;
	target?: number;
}

/**
 * Performance Test Helper
 *
 * Provides utilities for:
 * - Async operation timing
 * - Cache hit rate measurement
 * - Performance benchmarking
 * - Target enforcement
 *
 * Example:
 * ```typescript
 * const { elapsed, passed } = await PerformanceTestHelper.measureAsync(
 *   () => cache.getBatchStatus(uri),
 *   100 // Target: <100ms
 * );
 * expect(passed).toBe(true);
 * ```
 */
export class PerformanceTestHelper {
	/**
	 * Measure async operation execution time
	 *
	 * @param operation - Async operation to measure
	 * @param maxMs - Maximum allowed time in ms
	 * @returns Measurement result
	 */
	static async measureAsync<T>(
		operation: () => Promise<T>,
		maxMs: number,
	): Promise<PerformanceResult<T>> {
		const start = performance.now();

		try {
			const result = await operation();
			const elapsed = performance.now() - start;
			const passed = elapsed < maxMs;

			return {
				elapsed,
				passed,
				result,
				details: passed
					? `✅ ${elapsed.toFixed(2)}ms (target: <${maxMs}ms)`
					: `❌ ${elapsed.toFixed(2)}ms (target: <${maxMs}ms)`,
			};
		} catch (error) {
			const elapsed = performance.now() - start;
			return {
				elapsed,
				passed: false,
				result: error as T,
				details: `❌ Failed after ${elapsed.toFixed(2)}ms: ${error}`,
			};
		}
	}

	/**
	 * Measure synchronous operation execution time
	 *
	 * @param operation - Sync operation to measure
	 * @param maxMs - Maximum allowed time in ms
	 * @returns Measurement result
	 */
	static measureSync<T>(
		operation: () => T,
		maxMs: number,
	): PerformanceResult<T> {
		const start = performance.now();

		try {
			const result = operation();
			const elapsed = performance.now() - start;
			const passed = elapsed < maxMs;

			return {
				elapsed,
				passed,
				result,
				details: passed
					? `✅ ${elapsed.toFixed(2)}ms (target: <${maxMs}ms)`
					: `❌ ${elapsed.toFixed(2)}ms (target: <${maxMs}ms)`,
			};
		} catch (error) {
			const elapsed = performance.now() - start;
			return {
				elapsed,
				passed: false,
				result: error as T,
				details: `❌ Failed after ${elapsed.toFixed(2)}ms: ${error}`,
			};
		}
	}

	/**
	 * Measure cache hit rate over multiple operations
	 *
	 * @param operation - Operation that uses cache
	 * @param iterations - Number of iterations
	 * @param getCacheStats - Function to get cache statistics
	 * @returns Cache statistics
	 */
	static async measureCacheHitRate<T>(
		operation: () => Promise<T>,
		iterations: number,
		getCacheStats: () => { hits: number; misses: number; total: number },
	): Promise<CacheStats> {
		// Reset/get initial stats
		const initialStats = getCacheStats();

		// Run operations
		for (let i = 0; i < iterations; i++) {
			await operation();
		}

		// Get final stats
		const finalStats = getCacheStats();

		// Calculate delta
		const hits = finalStats.hits - initialStats.hits;
		const misses = finalStats.misses - initialStats.misses;
		const total = finalStats.total - initialStats.total;
		const hitRate = total > 0 ? (hits / total) * 100 : 0;

		return { hits, misses, total, hitRate };
	}

	/**
	 * Run performance benchmark
	 *
	 * Runs operation multiple times and collects statistics.
	 *
	 * @param name - Benchmark name
	 * @param operation - Operation to benchmark
	 * @param iterations - Number of iterations
	 * @param targetAvgMs - Target average time (optional)
	 * @returns Benchmark result
	 */
	static async benchmark(
		name: string,
		operation: () => Promise<void>,
		iterations: number,
		targetAvgMs?: number,
	): Promise<BenchmarkResult> {
		const times: number[] = [];

		for (let i = 0; i < iterations; i++) {
			const start = performance.now();
			await operation();
			const elapsed = performance.now() - start;
			times.push(elapsed);
		}

		const totalMs = times.reduce((sum, t) => sum + t, 0);
		const avgMs = totalMs / iterations;
		const minMs = Math.min(...times);
		const maxMs = Math.max(...times);
		const passed = targetAvgMs ? avgMs < targetAvgMs : true;

		return {
			name,
			iterations,
			totalMs,
			avgMs,
			minMs,
			maxMs,
			passed,
			target: targetAvgMs,
		};
	}

	/**
	 * Format benchmark result for display
	 *
	 * @param result - Benchmark result
	 * @returns Formatted string
	 */
	static formatBenchmark(result: BenchmarkResult): string {
		const status = result.passed ? "✅" : "❌";
		const targetInfo = result.target ? ` (target: <${result.target}ms)` : "";

		return `
${status} ${result.name}
  Iterations: ${result.iterations}
  Average: ${result.avgMs.toFixed(2)}ms${targetInfo}
  Min: ${result.minMs.toFixed(2)}ms
  Max: ${result.maxMs.toFixed(2)}ms
  Total: ${result.totalMs.toFixed(2)}ms
`.trim();
	}

	/**
	 * Assert performance target met
	 *
	 * Throws error if performance target not met.
	 * Use in tests to enforce performance requirements.
	 *
	 * @param result - Performance result
	 * @throws Error if target not met
	 */
	static assertPerformance<T>(result: PerformanceResult<T>): void {
		if (!result.passed) {
			throw new Error(`Performance target not met: ${result.details}`);
		}
	}

	/**
	 * Assert cache hit rate meets target
	 *
	 * @param stats - Cache statistics
	 * @param minHitRate - Minimum required hit rate (0-100)
	 * @throws Error if target not met
	 */
	static assertCacheHitRate(stats: CacheStats, minHitRate: number): void {
		if (stats.hitRate < minHitRate) {
			throw new Error(
				`Cache hit rate ${stats.hitRate.toFixed(1)}% below target ${minHitRate}%\n` +
					`  Hits: ${stats.hits}\n` +
					`  Misses: ${stats.misses}\n` +
					`  Total: ${stats.total}`,
			);
		}
	}

	/**
	 * Wait for specified duration
	 *
	 * @param ms - Duration in milliseconds
	 */
	static async wait(ms: number): Promise<void> {
		await Bun.sleep(ms);
	}

	/**
	 * Create large mock dataset for testing
	 *
	 * @param count - Number of items to create
	 * @param generator - Function to generate item
	 * @returns Array of items
	 */
	static createLargeDataset<T>(
		count: number,
		generator: (index: number) => T,
	): T[] {
		return Array.from({ length: count }, (_, i) => generator(i));
	}

	/**
	 * Measure memory usage delta
	 *
	 * WARNING: Requires --expose-gc flag
	 *
	 * @param operation - Operation to measure
	 * @returns Memory delta in bytes
	 */
	static async measureMemory(operation: () => Promise<void>): Promise<number> {
		// Force GC if available
		if (global.gc) {
			global.gc();
			await PerformanceTestHelper.wait(100);
		}

		const memBefore = process.memoryUsage().heapUsed;
		await operation();

		if (global.gc) {
			global.gc();
			await PerformanceTestHelper.wait(100);
		}

		const memAfter = process.memoryUsage().heapUsed;
		return memAfter - memBefore;
	}

	/**
	 * Format bytes to human-readable string
	 *
	 * @param bytes - Bytes
	 * @returns Formatted string
	 */
	static formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";

		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
		const formatted = (bytes / k ** i).toFixed(2);

		return `${formatted} ${sizes[i]}`;
	}

	/**
	 * Run operation with timeout
	 *
	 * @param operation - Operation to run
	 * @param timeoutMs - Timeout in milliseconds
	 * @returns Operation result
	 * @throws Error if timeout exceeded
	 */
	static async withTimeout<T>(
		operation: () => Promise<T>,
		timeoutMs: number,
	): Promise<T> {
		const timeoutPromise = new Promise<T>((_, reject) => {
			setTimeout(
				() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		});

		return Promise.race([operation(), timeoutPromise]);
	}

	/**
	 * Retry operation with exponential backoff
	 *
	 * @param operation - Operation to retry
	 * @param maxAttempts - Maximum attempts
	 * @param baseDelayMs - Base delay in milliseconds
	 * @returns Operation result
	 */
	static async retry<T>(
		operation: () => Promise<T>,
		maxAttempts = 3,
		baseDelayMs = 100,
	): Promise<T> {
		let lastError: Error | undefined;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error as Error;

				if (attempt < maxAttempts) {
					const delay = baseDelayMs * 2 ** (attempt - 1);
					await PerformanceTestHelper.wait(delay);
				}
			}
		}

		throw new Error(
			`Operation failed after ${maxAttempts} attempts: ${lastError?.message}`,
		);
	}
}
