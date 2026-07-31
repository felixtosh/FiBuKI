/**
 * Memoize a zero-arg async factory, caching ONLY a fulfilled result.
 *
 * A rejection is deliberately NOT cached: the next call re-invokes the
 * factory. This fixes the "poisoned singleton" hazard of the plain
 * `promise ??= factory()` idiom, where a transient boot failure (the
 * database briefly unreachable, a slow first migration) caches the rejected
 * promise and every later call fails for the life of the process, needing a
 * restart to recover.
 *
 * Concurrent callers arriving during an in-flight attempt share that single
 * attempt's promise (one factory invocation), matching the success-path
 * behavior of the idiom this replaces.
 */
export function memoizeAsync<T>(factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = factory().catch((err) => {
        // Don't memoize the rejection — clear the slot so the next call
        // retries a fresh factory invocation.
        pending = null;
        throw err;
      });
    }
    return pending;
  };
}
