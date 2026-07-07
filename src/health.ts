// oz-erp-edge/src/health.ts
import type { Context } from 'hono';

import type { WorkerConfig, WorkerEnv } from './config.js';
import { normalizeBaseUrl } from './config.js';
import { getCloudRunIdToken } from './gcp-id-token.js';
import { problemJson } from './problem.js';
import type { RequestContext } from './request-context.js';
import { applySecurityHeaders } from './security.js';

type HonoVariables = Readonly<{
  requestContext: RequestContext;
  workerConfig: WorkerConfig;
}>;

type HonoContext = Context<{
  Bindings: WorkerEnv;
  Variables: HonoVariables;
}>;

export function livez(context: HonoContext): Response {
  const config = context.get('workerConfig');
  const requestContext = context.get('requestContext');
  const headers = applySecurityHeaders(new Headers());
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-request-id', requestContext.requestId);
  headers.set('x-correlation-id', requestContext.correlationId);

  return new Response(
    JSON.stringify({
      success: true,
      data: {
        service: config.APP_NAME,
        status: 'alive',
        version: config.APP_VERSION,
        environment: config.APP_ENV,
        timestamp: new Date().toISOString(),
      },
      request_id: requestContext.requestId,
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers,
    },
  );
}

export async function readyz(context: HonoContext): Promise<Response> {
  const config = context.get('workerConfig');
  const requestContext = context.get('requestContext');
  let token: string;

  try {
    token = await getCloudRunIdToken(config);
  } catch {
    return problemJson({
      status: 503,
      code: 'EDGE_CLOUD_RUN_TOKEN_UNAVAILABLE',
      title: 'Service Unavailable',
      detail: 'The edge gateway could not obtain a Cloud Run invocation token.',
      requestId: requestContext.requestId,
    });
  }

  const backendReadyUrl = `${normalizeBaseUrl(config.CLOUD_RUN_BASE_URL)}/readyz`;
  const response = await fetch(backendReadyUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-serverless-authorization': `Bearer ${token}`,
      'x-request-id': requestContext.requestId,
      'x-correlation-id': requestContext.correlationId,
    },
  });
  const headers = applySecurityHeaders(new Headers());
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-request-id', requestContext.requestId);
  headers.set('x-correlation-id', requestContext.correlationId);

  return new Response(
    JSON.stringify({
      success: response.ok,
      data: {
        service: config.APP_NAME,
        status: response.ok ? 'ready' : 'not_ready',
        backend_status: response.status,
        timestamp: new Date().toISOString(),
      },
      request_id: requestContext.requestId,
      timestamp: new Date().toISOString(),
    }),
    {
      status: response.ok ? 200 : 503,
      headers,
    },
  );
}
