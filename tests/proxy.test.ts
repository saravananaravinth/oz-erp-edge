// oz-erp-edge/tests/proxy.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '../src/index.js';
import { parseWorkerConfig, type WorkerEnv } from '../src/config.js';
import {
  isContentTypeAllowed,
  parseContentType,
  resolveMaxRequestBodyBytes,
} from '../src/proxy.js';
import { classifyBackendRoute, resolveBackendPath } from '../src/route-policy.js';

const localEnv: WorkerEnv = {
  APP_ENV: 'development',
  APP_NAME: 'oz-erp-edge-worker',
  APP_VERSION: '0.1.0',
  CLOUD_RUN_BASE_URL: 'http://localhost:8080',
  CLOUD_RUN_AUDIENCE: 'http://localhost:8080',
  CLOUD_RUN_AUTH_MODE: 'auto',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  MAX_BODY_BYTES: '1024',
};

const config = parseWorkerConfig(localEnv);
const endpointKey = 'endpoint-key-1234';
const publicToken = 'a'.repeat(32);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('route policy', () => {
  it('maps ERP paths and blocks every backend health surface', () => {
    expect(resolveBackendPath('/erp/auth/login/otp/request', config)).toBe(
      '/erp/auth/login/otp/request',
    );
    expect(resolveBackendPath('/erp/readyz', config)).toBeNull();
    expect(resolveBackendPath('/erp/metrics', config)).toBeNull();
    expect(resolveBackendPath('/erp/version', config)).toBeNull();
    expect(resolveBackendPath('/tasks/notification.send', config)).toBeNull();
  });

  it('classifies exact raw webhook and warranty upload routes', () => {
    expect(classifyBackendRoute('POST', `/erp/channel-ingest/webhooks/msg91/${endpointKey}`)).toBe(
      'RAW_WEBHOOK',
    );
    expect(
      classifyBackendRoute('POST', `/erp/engagement/public/forms/warranty/${publicToken}/files`),
    ).toBe('WARRANTY_MULTIPART');
    expect(classifyBackendRoute('POST', '/erp/auth/login/otp/request')).toBe('ERP_STANDARD');
  });
});

describe('content type policy', () => {
  it('supports JSON and structured JSON suffixes for standard ERP requests', () => {
    expect(isContentTypeAllowed('ERP_STANDARD', parseContentType('application/json'))).toBe(true);
    expect(
      isContentTypeAllowed(
        'ERP_STANDARD',
        parseContentType('application/vnd.ozotec.command+json; charset=utf-8'),
      ),
    ).toBe(true);
    expect(isContentTypeAllowed('ERP_STANDARD', parseContentType('text/plain'))).toBe(false);
  });

  it('requires a valid multipart boundary only for the warranty upload route', () => {
    expect(
      isContentTypeAllowed(
        'WARRANTY_MULTIPART',
        parseContentType('multipart/form-data; boundary=abc123'),
      ),
    ).toBe(true);
    expect(
      isContentTypeAllowed('WARRANTY_MULTIPART', parseContentType('multipart/form-data')),
    ).toBe(false);
    expect(resolveMaxRequestBodyBytes('WARRANTY_MULTIPART', config)).toBe(11 * 1024 * 1024);
    expect(resolveMaxRequestBodyBytes('ERP_STANDARD', config)).toBe(1024);
  });
});

describe('Worker proxy behavior', () => {
  it('accepts a bodyless mutation without a synthetic Content-Type', async () => {
    const backendFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', backendFetch);

    const response = await app.request(
      '/erp/auth/sessions/current/revoke',
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
        },
      },
      localEnv,
    );

    expect(response.status).toBe(204);
    expect(backendFetch).toHaveBeenCalledOnce();
  });

  it('accepts raw text webhook payloads without a browser Origin', async () => {
    const backendFetch = vi.fn(async () => Response.json({ accepted: true }));
    vi.stubGlobal('fetch', backendFetch);

    const response = await app.request(
      `/erp/channel-ingest/webhooks/msg91/${endpointKey}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
        },
        body: 'provider-payload',
      },
      localEnv,
    );

    expect(response.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledOnce();
  });

  it('rejects text payloads for ordinary ERP routes', async () => {
    const backendFetch = vi.fn(async () => Response.json({ unexpected: true }));
    vi.stubGlobal('fetch', backendFetch);

    const response = await app.request(
      '/erp/auth/login/otp/request',
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'text/plain',
        },
        body: 'invalid',
      },
      localEnv,
    );

    expect(response.status).toBe(415);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies even when no trusted Content-Length is supplied', async () => {
    const backendFetch = vi.fn(async () => Response.json({ unexpected: true }));
    vi.stubGlobal('fetch', backendFetch);
    const body = JSON.stringify({ payload: 'x'.repeat(2_000) });
    const request = new Request('https://edge.test/erp/auth/login/otp/request', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
      },
      body,
    });
    request.headers.delete('content-length');

    const response = await app.request(request, undefined, localEnv);

    expect(response.status).toBe(413);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it('strips spoofed infrastructure headers and preserves user Authorization', async () => {
    let forwardedRequest: Request | null = null;
    const backendFetch = vi.fn(async (request: RequestInfo | URL) => {
      forwardedRequest = request instanceof Request ? request : new Request(request);
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', backendFetch);

    const response = await app.request(
      '/erp/auth/me',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer user-access-token',
          'x-serverless-authorization': 'Bearer attacker-token',
          'x-cloudtasks-taskname': 'attacker-task',
          'x-forwarded-for': '203.0.113.99',
        },
      },
      localEnv,
    );

    expect(response.status).toBe(200);
    expect(forwardedRequest).not.toBeNull();
    expect(forwardedRequest?.headers.get('authorization')).toBe('Bearer user-access-token');
    expect(forwardedRequest?.headers.get('x-serverless-authorization')).toBeNull();
    expect(forwardedRequest?.headers.get('x-cloudtasks-taskname')).toBeNull();
    expect(forwardedRequest?.headers.get('x-forwarded-for')).toBeNull();
  });

  it('strengthens weaker backend security headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { ok: true },
          {
            headers: {
              'referrer-policy': 'unsafe-url',
              'cross-origin-resource-policy': 'cross-origin',
            },
          },
        ),
      ),
    );

    const response = await app.request('/erp/auth/jwks', undefined, localEnv);

    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
