/**
 * Runs an asynchronous operation with an AbortSignal and rejects if it
 * exceeds the specified timeout.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError("Timeout must be a non-negative finite number");
  }

  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeoutError = new DOMException(
        "Operation timed out",
        "TimeoutError",
      );

      controller.abort(timeoutError);
      reject(timeoutError);
    }, ms);
  });

  try {
    // Promise.resolve().then also converts a synchronous throw from fn
    // into a rejection, so the timer is always cleaned up in finally.
    return await Promise.race([
      Promise.resolve().then(() => fn(controller.signal)),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
