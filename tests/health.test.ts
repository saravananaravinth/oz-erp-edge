// oz-erp-edge/tests/health.test.ts
import { describe, expect, it, vi } from 'vitest';

import { parseWorkerConfig } from '../src/config.js';
import { checkBackendReadiness } from '../src/health.js';

const config = parseWorkerConfig({
  APP_ENV: 'development',
  CLOUD_RUN_BASE_URL: 'http://localhost:8080',
  CLOUD_RUN_AUDIENCE: 'http://localhost:8080',
  CLOUD_RUN_AUTH_MODE: 'auto',
  ALLOWED_ORIGINS: 'http://localhost:3000',
});

const requestContext = {
  requestId: 'request-12345678',
  correlationId: 'correlation-12345678',
  startedAtMs: 1,
} as const;

function validReadyEnvelope(): unknown {
  return {
    success: true,
    data: {
      service: 'oz-erp-api',
      status: 'ready',
      uptime_seconds: 42,
      timestamp: '2026-07-14T00:00:00.000Z',
      dependencies: [
        { name: 'postgres', status: 'up', latency_ms: 1.2 },
        { name: 'redis', status: 'up', latency_ms: 0.8 },
      ],
    },
    request_id: 'backend-request-1234',
    timestamp: '2026-07-14T00:00:00.000Z',
  };
}

describe('checkBackendReadiness', () => {
  it('calls the configured private API readiness path and validates the contract', async () => {
    const fetcher = vi.fn(async () => Response.json(validReadyEnvelope(), { status: 200 }));

    const result = await checkBackendReadiness({
      config,
      requestContext,
      fetcher,
    });

    expect(result).toEqual({
      ready: true,
      backendStatus: 200,
      validation: 'valid',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost:8080/erp/readyz',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });

  it('fails closed when the backend response violates the strict schema', async () => {
    const invalidEnvelope = {
      ...(validReadyEnvelope() as Record<string, unknown>),
      unexpected: true,
    };
    const fetcher = vi.fn(async () => Response.json(invalidEnvelope, { status: 200 }));

    const result = await checkBackendReadiness({
      config,
      requestContext,
      fetcher,
    });

    expect(result).toEqual({
      ready: false,
      backendStatus: 200,
      validation: 'invalid',
    });
  });

  it('requires HTTP 200 even when the response body says ready', async () => {
    const fetcher = vi.fn(async () => Response.json(validReadyEnvelope(), { status: 503 }));

    const result = await checkBackendReadiness({
      config,
      requestContext,
      fetcher,
    });

    expect(result.ready).toBe(false);
    expect(result.backendStatus).toBe(503);
  });
});
