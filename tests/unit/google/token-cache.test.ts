// oz-erp-edge/tests/unit/google/token-cache.test.ts
import { describe, expect, it } from 'vitest';

import { BoundedTokenCache } from '../../../src/infrastructure/google/token-cache.js';

describe('bounded token cache', () => {
  it('stores only reusable token data and enforces its maximum size', () => {
    const cache = new BoundedTokenCache(2);
    const nowMs = Date.now();

    cache.set('a', { value: 'token-a', expiresAtMs: nowMs + 120_000 });
    cache.set('b', { value: 'token-b', expiresAtMs: nowMs + 120_000 });
    expect(cache.get('a', nowMs)).toBe('token-a');

    cache.set('c', { value: 'token-c', expiresAtMs: nowMs + 120_000 });

    expect(cache.size).toBe(2);
    expect(cache.get('a', nowMs)).toBe('token-a');
    expect(cache.get('b', nowMs)).toBeNull();
    expect(cache.get('c', nowMs)).toBe('token-c');
  });

  it('rejects tokens within the expiry safety window', () => {
    const cache = new BoundedTokenCache();
    const nowMs = Date.now();

    cache.set('expired', { value: 'token', expiresAtMs: nowMs + 30_000 });

    expect(cache.get('expired', nowMs)).toBeNull();
    expect(cache.size).toBe(0);
  });
});
