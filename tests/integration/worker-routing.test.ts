import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkerApp } from '../../src/apps/worker/worker.app.js';
import type { EdgeLogger } from '../../src/observability/observability.types.js';
import { CloudRunTokenError } from '../../src/shared/auth/cloud-run-token.error.js';
import { createLocalWorkerEnv } from '../fixtures/worker-env.js';

const logInfo = vi.fn();
const logError = vi.fn();
const logger: EdgeLogger = {
  info: logInfo,
  error: logError,
};

function backendReadyResponse(): Response {
  const timestamp = new Date().toISOString();
  return Response.json({
    success: true,
    data: {
      service: 'oz-erp-api',
      status: 'ready',
      uptime_seconds: 10,
      timestamp,
      dependencies: [
        { name: 'postgres', status: 'up', latency_ms: 1 },
        { name: 'redis', status: 'up', latency_ms: 1 },
      ],
    },
    request_id: 'backend-request-id',
    timestamp,
  });
}

describe('worker integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves liveness with production bindings and reports the Cloudflare version tag', async () => {
    const app = createWorkerApp({ logger, fetcher: vi.fn(), tokenProvider: vi.fn() });
    const env = createLocalWorkerEnv({
      APP_ENV: 'production',
      ALLOWED_ORIGINS: 'https://erp.ozotecev.com',
      CLOUD_RUN_BASE_URL: 'https://service.run.app',
      CLOUD_RUN_AUDIENCE: 'https://service.run.app',
      CLOUD_RUN_AUTH_MODE: 'id_token',
      GCP_SERVICE_ACCOUNT_JSON_B64: 'A'.repeat(128),
      CF_VERSION_METADATA: {
        id: '11111111-1111-4111-8111-111111111111',
        tag: 'v0.5.0-test',
        timestamp: '2026-07-20T00:00:00.000Z',
      },
    });

    const response = await app.request('https://api.erp.ozotecev.com/livez', undefined, env);
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        status: 'alive',
        version: 'v0.5.0-test',
        environment: 'production',
        cloud_run_auth_mode: 'id_token',
      },
    });
  });

  it('serves health and blocks private backend readiness from public proxying', async () => {
    const fetcher = vi.fn(async () => backendReadyResponse());
    const app = createWorkerApp({ logger, fetcher, tokenProvider: vi.fn() });
    const env = createLocalWorkerEnv();

    const live = await app.request('http://edge.local/livez', undefined, env);
    expect(live.status).toBe(200);
    const ready = await app.request('http://edge.local/readyz', undefined, env);
    expect(ready.status).toBe(200);

    const blocked = await app.request('http://edge.local/erp/readyz', undefined, env);
    expect(blocked.status).toBe(404);
  });

  it('authenticates production readiness and returns the backend readiness contract', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-serverless-authorization')).toBe(
        'Bearer signed-cloud-run-token',
      );
      return backendReadyResponse();
    });
    const tokenProvider = vi.fn(async () => 'signed-cloud-run-token');
    const app = createWorkerApp({ logger, fetcher, tokenProvider });
    const env = createLocalWorkerEnv({
      APP_ENV: 'production',
      ALLOWED_ORIGINS: 'https://erp.ozotecev.com',
      CLOUD_RUN_BASE_URL: 'https://service.run.app',
      CLOUD_RUN_AUDIENCE: 'https://service.run.app',
      CLOUD_RUN_AUTH_MODE: 'id_token',
      GCP_SERVICE_ACCOUNT_JSON_B64: 'A'.repeat(128),
    });

    const response = await app.request('https://api.erp.ozotecev.com/readyz', undefined, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { status: 'ready', cloud_run_auth_mode: 'id_token' },
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it('keeps token failures public-safe and emits only categorized diagnostics', async () => {
    const sensitiveFailureDetails =
      'assertion=signed-assertion token=signed-cloud-run-token -----BEGIN PRIVATE KEY----- service-account-json upstream response body';
    const app = createWorkerApp({
      logger,
      fetcher: vi.fn(),
      tokenProvider: vi.fn(async () => {
        throw Object.assign(new CloudRunTokenError('exchange_http', 429), {
          cause: new Error(sensitiveFailureDetails),
        });
      }),
    });
    const secretValue = 'A'.repeat(128);
    const env = createLocalWorkerEnv({
      APP_ENV: 'production',
      ALLOWED_ORIGINS: 'https://erp.ozotecev.com',
      CLOUD_RUN_BASE_URL: 'https://service.run.app',
      CLOUD_RUN_AUDIENCE: 'https://service.run.app',
      CLOUD_RUN_AUTH_MODE: 'id_token',
      GCP_SERVICE_ACCOUNT_JSON_B64: secretValue,
      CF_VERSION_METADATA: {
        id: '11111111-1111-4111-8111-111111111111',
        tag: 'v0.6.0-test',
        timestamp: '2026-07-20T00:00:00.000Z',
      },
    });

    const response = await app.request('https://api.erp.ozotecev.com/readyz', undefined, env);
    const body: unknown = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      code: 'EDGE_CLOUD_RUN_TOKEN_UNAVAILABLE',
      detail: 'The edge gateway could not obtain a Cloud Run invocation token.',
    });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'edge_cloud_run_token_failure',
        failure_category: 'exchange_http',
        exchange_http_status: 429,
        worker_version: '11111111-1111-4111-8111-111111111111',
        worker_tag: 'v0.6.0-test',
      }),
    );
    const serializedLogs = JSON.stringify(logError.mock.calls);
    expect(serializedLogs).not.toContain(secretValue);
    for (const sensitiveFragment of sensitiveFailureDetails.split(' ')) {
      expect(serializedLogs).not.toContain(sensitiveFragment);
    }
  });

  it('does not treat a bearer token as an origin bypass', async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true }));
    const app = createWorkerApp({ logger, fetcher, tokenProvider: vi.fn() });
    const response = await app.request(
      'http://edge.local/erp/inventory/vehicles/export',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer aaa.bbb.ccc',
          'content-type': 'application/json',
        },
        body: '{}',
      },
      createLocalWorkerEnv(),
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('proxies allowed browser traffic with sanitized headers', async () => {
    const receivedRequests: Request[] = [];
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      receivedRequests.push(request instanceof Request ? request : new Request(request));
      return Response.json({ success: true }, { headers: { server: 'hidden' } });
    });
    const app = createWorkerApp({ logger, fetcher, tokenProvider: vi.fn() });
    const response = await app.request(
      'http://edge.local/erp/auth/token/refresh',
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          authorization: 'Bearer aaa.bbb.ccc',
          'x-serverless-authorization': 'Bearer attacker',
          'content-type': 'application/json',
        },
        body: '{}',
      },
      createLocalWorkerEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.has('server')).toBe(false);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const receivedRequest = receivedRequests[0];
    expect(receivedRequest).toBeDefined();
    expect(receivedRequest?.headers.get('authorization')).toBe('Bearer aaa.bbb.ccc');
    expect(receivedRequest?.headers.has('x-serverless-authorization')).toBe(false);
  });
});
