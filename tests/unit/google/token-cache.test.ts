import { describe, expect, it, vi } from 'vitest';

import { BoundedTokenCache } from '../../../src/infrastructure/google/token-cache.js';

describe('bounded token cache', () => {
  it('deduplicates concurrent creation and enforces its maximum size', async () => {
    const cache = new BoundedTokenCache(2);
    const factory = vi.fn(async () => ({ value: 'token-a', expiresAtMs: Date.now() + 120_000 }));

    const values = await Promise.all([
      cache.getOrCreate('a', factory),
      cache.getOrCreate('a', factory),
      cache.getOrCreate('a', factory),
    ]);
    expect(values).toEqual(['token-a', 'token-a', 'token-a']);
    expect(factory).toHaveBeenCalledTimes(1);

    await cache.getOrCreate('b', async () => ({
      value: 'token-b',
      expiresAtMs: Date.now() + 120_000,
    }));
    await cache.getOrCreate('c', async () => ({
      value: 'token-c',
      expiresAtMs: Date.now() + 120_000,
    }));
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeNull();
  });
});
