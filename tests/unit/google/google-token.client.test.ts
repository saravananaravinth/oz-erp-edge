// oz-erp-edge/tests/unit/google/google-token.client.test.ts
import { describe, expect, it, vi } from 'vitest';

import { exchangeGoogleIdToken } from '../../../src/infrastructure/google/google-token.client.js';

const baseInput = {
  tokenUri: 'https://oauth2.googleapis.com/token',
  assertion: 'signed-assertion',
  timeoutMs: 100,
} as const;

describe('Google ID token exchange', () => {
  it.each([
    ['exchange_network', async () => await Promise.reject(new Error('network detail'))],
    ['exchange_invalid_response', async () => new Response('not-json', { status: 200 })],
  ] as const)(
    'categorizes %s without retaining sensitive upstream details',
    async (category, fetcher) => {
      await expect(exchangeGoogleIdToken({ ...baseInput, fetcher })).rejects.toMatchObject({
        category,
        message: 'Cloud Run invocation token acquisition failed.',
      });
    },
  );

  it('records only the safe status for a non-success response', async () => {
    const fetcher = vi.fn(async () => new Response('sensitive response body', { status: 429 }));

    await expect(exchangeGoogleIdToken({ ...baseInput, fetcher })).rejects.toMatchObject({
      category: 'exchange_http',
      httpStatus: 429,
    });
  });

  it('categorizes an exchange timeout', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('Request aborted.'));
          },
          { once: true },
        );
      });
      return Response.json({});
    });

    await expect(
      exchangeGoogleIdToken({ ...baseInput, timeoutMs: 5, fetcher }),
    ).rejects.toMatchObject({ category: 'exchange_timeout' });
  });
});
