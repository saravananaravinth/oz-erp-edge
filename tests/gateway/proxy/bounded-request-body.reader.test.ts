import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../../../src/config/index.js';
import {
  prepareRequestBody,
  type PreparedRequestBody,
} from '../../../src/gateway/proxy/bounded-request-body.reader.js';
import type { RequestContext } from '../../../src/gateway/http/request-context.js';
import type { BackendRouteClass } from '../../../src/gateway/routing/route-classifier.js';

const config = parseWorkerConfig({
  APP_ENV: 'development',
  CLOUD_RUN_BASE_URL: 'http://localhost:8080',
  CLOUD_RUN_AUDIENCE: 'http://localhost:8080',
  CLOUD_RUN_AUTH_MODE: 'disabled',
});

const requestContext: RequestContext = {
  requestId: 'test-request-id',
  correlationId: 'test-correlation-id',
  startedAtMs: 0,
};

function request(
  method: string,
  options: Readonly<{
    body?: BodyInit;
    contentType?: string;
  }> = {},
): Request {
  const headers = new Headers();
  if (options.contentType !== undefined) {
    headers.set('content-type', options.contentType);
  }

  return new Request('https://erp.example.test/erp/test', {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

async function prepare(inputRequest: Request, routeClass: BackendRouteClass = 'ERP_STANDARD') {
  return await prepareRequestBody({
    request: inputRequest,
    routeClass,
    config,
    requestContext,
  });
}

function expectPreparedBody(result: PreparedRequestBody | Response): PreparedRequestBody {
  expect(result).not.toBeInstanceOf(Response);
  return result as PreparedRequestBody;
}

async function expectProblemCode(result: PreparedRequestBody | Response, code: string) {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(415);
  await expect(response.json()).resolves.toMatchObject({ code });
}

describe('prepareRequestBody', () => {
  it.each(['POST', 'DELETE'])('accepts a bodyless %s without Content-Type', async (method) => {
    const result = expectPreparedBody(await prepare(request(method)));

    expect(result).toEqual({
      body: null,
      byteLength: 0,
      rawWebhookBodySha256: null,
    });
  });

  it('accepts a zero-byte mutation stream without Content-Type', async () => {
    const result = expectPreparedBody(await prepare(request('POST', { body: new Uint8Array(0) })));

    expect(result).toEqual({
      body: null,
      byteLength: 0,
      rawWebhookBodySha256: null,
    });
  });

  it('rejects a non-empty standard mutation without Content-Type', async () => {
    const result = await prepare(request('POST', { body: new Uint8Array([123, 125]) }));

    await expectProblemCode(result, 'EDGE_UNSUPPORTED_MEDIA_TYPE');
  });

  it('accepts a non-empty JSON mutation', async () => {
    const result = expectPreparedBody(
      await prepare(
        request('POST', {
          body: new Uint8Array([123, 125]),
          contentType: 'application/json',
        }),
      ),
    );

    expect(result.byteLength).toBe(2);
    expect(result.body).not.toBeNull();
  });

  it('rejects an unsupported media type for a non-empty standard mutation', async () => {
    const result = await prepare(
      request('POST', {
        body: new Uint8Array([116, 101, 120, 116]),
        contentType: 'text/plain',
      }),
    );

    await expectProblemCode(result, 'EDGE_UNSUPPORTED_MEDIA_TYPE');
  });

  it('requires a valid boundary for a non-empty multipart upload', async () => {
    const result = await prepare(
      request('POST', {
        body: new Uint8Array([45, 45]),
        contentType: 'multipart/form-data',
      }),
      'WARRANTY_MULTIPART',
    );

    await expectProblemCode(result, 'EDGE_UNSUPPORTED_MEDIA_TYPE');
  });

  it('accepts a non-empty multipart upload with a valid boundary', async () => {
    const result = expectPreparedBody(
      await prepare(
        request('POST', {
          body: new Uint8Array([45, 45]),
          contentType: 'multipart/form-data; boundary=test-boundary',
        }),
        'WARRANTY_MULTIPART',
      ),
    );

    expect(result.byteLength).toBe(2);
  });

  it('rejects a malformed webhook Content-Type', async () => {
    const result = await prepare(
      request('POST', {
        body: new Uint8Array([123, 125]),
        contentType: 'malformed',
      }),
      'RAW_WEBHOOK',
    );

    await expectProblemCode(result, 'EDGE_UNSUPPORTED_MEDIA_TYPE');
  });
});
