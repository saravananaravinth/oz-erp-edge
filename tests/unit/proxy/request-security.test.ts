import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../../../src/config/index.js';
import { prepareRequestBody } from '../../../src/gateway/proxy/bounded-request-body.reader.js';
import { buildBackendHeaders } from '../../../src/gateway/proxy/request-header.policy.js';
import { createLocalWorkerEnv } from '../../fixtures/worker-env.js';

const requestContext = {
  requestId: 'request-id-12345678',
  correlationId: 'correlation-id-12345678',
  startedAtMs: Date.now(),
} as const;

describe('request header trust boundary', () => {
  it('strips infrastructure identity and preserves end-user authorization', () => {
    const request = new Request('https://api.erp.ozotecev.com/erp/example', {
      headers: {
        authorization: 'Bearer user.token.value',
        'x-serverless-authorization': 'Bearer attacker',
        'x-cloudtasks-queuename': 'attacker',
        cookie: 'session=attacker',
        'cf-connecting-ip': '203.0.113.7',
      },
    });
    const headers = buildBackendHeaders({
      request,
      invocationToken: 'trusted-token',
      requestContext,
    });

    expect(headers.get('authorization')).toBe('Bearer user.token.value');
    expect(headers.get('x-serverless-authorization')).toBe('Bearer trusted-token');
    expect(headers.has('x-cloudtasks-queuename')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
  });
});

describe('bounded body reader', () => {
  it('rejects malformed Content-Length before reading the body', async () => {
    const config = parseWorkerConfig(createLocalWorkerEnv());
    const request = new Request('https://api.erp.ozotecev.com/erp/example', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 'not-a-number' },
      body: '{}',
    });
    const result = await prepareRequestBody({
      request,
      routeClass: 'ERP_STANDARD',
      config,
      requestContext,
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it('rejects compressed requests', async () => {
    const config = parseWorkerConfig(createLocalWorkerEnv());
    const result = await prepareRequestBody({
      request: new Request('https://api.erp.ozotecev.com/erp/example', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: '{}',
      }),
      routeClass: 'ERP_STANDARD',
      config,
      requestContext,
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(415);
  });

  it('rejects an unknown-length stream after crossing the limit', async () => {
    const config = parseWorkerConfig(createLocalWorkerEnv({ MAX_BODY_BYTES: '1024' }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(800));
        controller.enqueue(new Uint8Array(800));
        controller.close();
      },
    });
    const request = new Request('https://api.erp.ozotecev.com/erp/example', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    request.headers.delete('content-length');

    const result = await prepareRequestBody({
      request,
      routeClass: 'ERP_STANDARD',
      config,
      requestContext,
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });
});
