// oz-erp-edge/tests/unit/health/backend-readiness.test.ts
import { describe, expect, it, vi } from 'vitest';

import { parseWorkerConfig } from '../../../src/config/index.js';
import {
  checkBackendReadiness,
  ReadinessTokenError,
} from '../../../src/operations/health/backend-readiness.client.js';
import { createLocalWorkerEnv } from '../../fixtures/worker-env.js';

const requestContext = {
  requestId: 'request-id-12345678',
  correlationId: 'correlation-id-12345678',
  startedAtMs: Date.now(),
} as const;

describe('backend readiness client', () => {
  it('fails closed on an invalid backend envelope', async () => {
    const result = await checkBackendReadiness({
      config: parseWorkerConfig(createLocalWorkerEnv()),
      requestContext,
      dependencies: {
        fetcher: vi.fn(async () => Response.json({ status: 'ready' })),
        tokenProvider: vi.fn(),
      },
    });

    expect(result).toEqual({ ready: false, backendStatus: 200, validation: 'invalid' });
  });

  it('classifies invocation-token failure without calling the backend', async () => {
    const fetcher = vi.fn();
    const config = parseWorkerConfig(
      createLocalWorkerEnv({
        CLOUD_RUN_BASE_URL: 'https://service.run.app',
        CLOUD_RUN_AUDIENCE: 'https://service.run.app',
        CLOUD_RUN_AUTH_MODE: 'id_token',
        GCP_SERVICE_ACCOUNT_JSON_B64: 'A'.repeat(128),
      }),
    );

    await expect(
      checkBackendReadiness({
        config,
        requestContext,
        dependencies: {
          fetcher,
          tokenProvider: vi.fn(async () => {
            throw new Error('unavailable');
          }),
        },
      }),
    ).rejects.toBeInstanceOf(ReadinessTokenError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
