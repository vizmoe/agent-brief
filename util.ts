export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bound the wait as well as signalling cancellation to the underlying operation. */
export async function withTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	parent?: AbortSignal,
): Promise<T> {
	const controller = new AbortController();
	let rejectAbort: (reason: unknown) => void = () => undefined;
	const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	const abort = (reason: unknown): void => {
		controller.abort(reason);
		rejectAbort(reason);
	};
	const onAbort = (): void => abort(parent?.reason ?? new DOMException("Cancelled", "AbortError"));
	const timer = setTimeout(() => abort(new DOMException("Operation timed out", "TimeoutError")), timeoutMs);
	timer.unref?.();
	parent?.addEventListener("abort", onAbort, { once: true });
	try {
		if (parent?.aborted) onAbort();
		return await Promise.race([
			Promise.resolve().then(() => {
				controller.signal.throwIfAborted();
				return operation(controller.signal);
			}),
			cancelled,
		]);
	} finally {
		clearTimeout(timer);
		parent?.removeEventListener("abort", onAbort);
	}
}
