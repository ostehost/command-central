type WaitForOptions = {
	timeout?: number;
	interval?: number;
	message?: string;
};

function formatValue(value: unknown): string {
	if (value instanceof Error) {
		return value.message;
	}

	if (typeof value === "string") {
		return value;
	}

	if (value === undefined) {
		return "undefined";
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export async function waitFor<T>(
	predicate: () => T | Promise<T>,
	options: WaitForOptions = {},
): Promise<T> {
	const timeout = options.timeout ?? 5000;
	const interval = options.interval ?? 10;
	const message = options.message ?? "Condition not met";
	const deadline = Date.now() + timeout;
	let lastResult: unknown;
	let lastError: unknown;

	while (Date.now() < deadline) {
		try {
			const result = await predicate();
			lastResult = result;
			if (result) {
				return result;
			}
		} catch (error) {
			lastError = error;
		}

		await new Promise((resolve) => setTimeout(resolve, interval));
	}

	const suffix = lastError
		? ` Last error: ${formatValue(lastError)}.`
		: ` Last result: ${formatValue(lastResult)}.`;
	throw new Error(`${message} (timeout: ${timeout}ms).${suffix}`);
}
