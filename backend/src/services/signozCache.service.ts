
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();
  private inFlight = new Map<string, Promise<T>>();

  constructor(private readonly defaultTtlMs: number) {}

  /**
   * Returns the cached value for `key` if still fresh; otherwise calls
   * `fetcher()` — but only once even under concurrent callers — caches
   * the result, and returns it. A fetcher that throws is never cached,
   * and does not poison in-flight de-dupe for the next caller.
   */
  async getOrFetch(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number = this.defaultTtlMs,
  ): Promise<T> {
    const cached = this.store.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = fetcher()
      .then((value) => {
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /** Drops one key — use when an action (e.g. a fix was applied and the
   * container restarted) makes cached telemetry for that key stale before
   * its TTL would naturally expire. */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Drops every cached key with this prefix — e.g. invalidate everything
   * for one repositoryId after a run stops. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }
}
