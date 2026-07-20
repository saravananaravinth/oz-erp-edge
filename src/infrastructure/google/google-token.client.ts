// oz-erp-edge/src/infrastructure/google/google-token.client.ts
import { z } from 'zod';

import { OperationTimeoutError, withTimeout } from '../../shared/async/timeout.js';
import { CloudRunTokenError } from '../../shared/auth/cloud-run-token.error.js';
import type { OutboundFetcher } from '../../shared/http/outbound-fetch.js';

const googleTokenResponseSchema = z
  .object({
    id_token: z
      .string()
      .min(100)
      .max(8192)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u),
    token_type: z.string().min(1).max(128).optional(),
    expires_in: z.union([z.number().int().positive(), z.string().regex(/^\d+$/u)]).optional(),
  })
  .strict();

export type GoogleIdTokenResult = Readonly<{
  value: string;
  expiresInSeconds: number;
}>;

export async function exchangeGoogleIdToken(input: {
  readonly fetcher: OutboundFetcher;
  readonly tokenUri: string;
  readonly assertion: string;
  readonly timeoutMs: number;
}): Promise<GoogleIdTokenResult> {
  let response: Response;
  try {
    response = await withTimeout({
      timeoutMs: input.timeoutMs,
      timeoutMessage: 'Google ID token exchange timed out.',
      operation: async (signal) =>
        await input.fetcher(input.tokenUri, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: input.assertion,
          }).toString(),
          signal,
        }),
    });
  } catch (error: unknown) {
    throw new CloudRunTokenError(
      error instanceof OperationTimeoutError ? 'exchange_timeout' : 'exchange_network',
    );
  }

  if (!response.ok) throw new CloudRunTokenError('exchange_http', response.status);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CloudRunTokenError('exchange_invalid_response');
  }

  const parsed = googleTokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new CloudRunTokenError('exchange_invalid_response');

  const expiresInSeconds =
    parsed.data.expires_in === undefined
      ? 3600
      : typeof parsed.data.expires_in === 'number'
        ? parsed.data.expires_in
        : Number.parseInt(parsed.data.expires_in, 10);

  return { value: parsed.data.id_token, expiresInSeconds };
}
