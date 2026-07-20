// oz-erp-edge/tests/unit/shared/outbound-fetch.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { outboundFetch } from '../../../src/shared/http/outbound-fetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('outbound fetch adapter', () => {
  it('invokes the runtime fetch function with its global receiver', async () => {
    const runtimeFetch = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(new Response('ok'));
    });
    vi.stubGlobal('fetch', runtimeFetch);
    const dependencies = { fetcher: outboundFetch };

    const response = await dependencies.fetcher('https://example.com');

    expect(await response.text()).toBe('ok');
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
  });
});
