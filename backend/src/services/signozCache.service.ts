interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();
  private inFlight = new Map<string, Promise<T>>();
  /** LRU order: the first key is the least recently used, the last is the most recent. */
  private usage = new Map<string, true>();
  private readonly maxSize: number;

  constructor(
    private readonly defaultTtlMs: number,
    maxSize: number = 500,
  ) {
    if (!(maxSize >= 1)) {
      throw new RangeError("TtlCache maxSize must be at least 1");
    }
    this.maxSize = maxSize;
  }

  /**
   * Returns the cached value for `key` if still fresh; otherwise calls
   * `fetcher()` — but only once even under concurrent callers — caches
   * the result, and returns it. A fetcher that throws is never cached,
   * and does not poison in-flight de-dupe for the next caller.
   *
   * The cache holds at most `maxSize` entries. When a new entry would
   * exceed that, the least recently used entry is evicted, except keys
   * that still have a fetch in flight.
   */
  async getOrFetch(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number = this.defaultTtlMs,
  ): Promise<T> {
    const cached = this.store.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.touch(key);
      return cached.value;
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = fetcher()
      .then((value) => {
        // an expired entry for this key is replaced, so it must not count toward the size
        this.store.delete(key);
        this.usage.delete(key);

        this.evictIfNeeded();
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
        this.touch(key);
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
    this.usage.delete(key);
  }

  /** Drops every cached key with this prefix — e.g. invalidate everything
   * for one repositoryId after a run stops. */
  invalidatePrefix(prefix: string): void {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.invalidate(key);
    }
  }

  clear(): void {
    this.store.clear();
    this.usage.clear();
  }

  /** Marks `key` as the most recently used. */
  private touch(key: string): void {
    this.usage.delete(key);
    this.usage.set(key, true);
  }

  /**
   * Makes room for one more entry: while the store is full, removes the least
   * recently used key that has no fetch in flight. Keys in `inFlight` are
   * never evicted. If every key is in flight, nothing is removed.
   */
  private evictIfNeeded(): void {
    while (this.store.size >= this.maxSize) {
      let victim: string | undefined;
      for (const key of this.usage.keys()) {
        if (!this.inFlight.has(key)) {
          victim = key;
          break;
        }
      }
      if (victim === undefined) return;
      this.usage.delete(victim);
      this.store.delete(victim);
    }
  }
}
