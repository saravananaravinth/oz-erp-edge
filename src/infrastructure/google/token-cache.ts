export type CachedToken = Readonly<{
  value: string;
  expiresAtMs: number;
}>;

export class BoundedTokenCache {
  readonly #maxEntries: number;
  readonly #tokens = new Map<string, CachedToken>();
  readonly #inFlight = new Map<string, Promise<CachedToken>>();

  public constructor(maxEntries = 8) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) {
      throw new Error('Token cache maxEntries must be an integer between 1 and 64.');
    }
    this.#maxEntries = maxEntries;
  }

  public get(key: string, nowMs = Date.now()): string | null {
    this.pruneExpired(nowMs);
    const cached = this.#tokens.get(key);
    if (cached === undefined || cached.expiresAtMs <= nowMs + 30_000) return null;

    this.#tokens.delete(key);
    this.#tokens.set(key, cached);
    return cached.value;
  }

  public async getOrCreate(key: string, factory: () => Promise<CachedToken>): Promise<string> {
    const cached = this.get(key);
    if (cached !== null) return cached;

    const active = this.#inFlight.get(key);
    if (active !== undefined) return (await active).value;

    const pending = factory();
    this.#inFlight.set(key, pending);
    try {
      const created = await pending;
      this.#tokens.delete(key);
      this.#tokens.set(key, created);
      this.#enforceBound();
      return created.value;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  public pruneExpired(nowMs = Date.now()): void {
    for (const [key, token] of this.#tokens) {
      if (token.expiresAtMs <= nowMs + 30_000) this.#tokens.delete(key);
    }
  }

  public clear(): void {
    this.#tokens.clear();
    this.#inFlight.clear();
  }

  public get size(): number {
    return this.#tokens.size;
  }

  #enforceBound(): void {
    while (this.#tokens.size > this.#maxEntries) {
      const oldestKey = this.#tokens.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.#tokens.delete(oldestKey);
    }
  }
}
