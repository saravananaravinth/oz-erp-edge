// oz-erp-edge/src/cors.ts
import type { Context, MiddlewareHandler, Next } from 'hono';

import type { WorkerConfig, WorkerEnv } from './config.js';
import { problemJson } from './problem.js';
import type { RequestContext } from './request-context.js';

type HonoBindings = Readonly<WorkerEnv>;
type HonoVariables = Readonly<{
  requestContext: RequestContext;
  workerConfig: WorkerConfig;
}>;

type HonoContext = Context<{
  Bindings: HonoBindings;
  Variables: HonoVariables;
}>;

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isOriginAllowed(origin: string | null, config: WorkerConfig): boolean {
  if (origin === null) {
    return true;
  }

  if (config.ALLOWED_ORIGINS.includes('*')) {
    return true;
  }

  return config.ALLOWED_ORIGINS.includes(origin);
}

function buildCorsHeaders(origin: string | null, config: WorkerConfig): Headers {
  const headers = new Headers();
  headers.set('vary', 'Origin');
  headers.set('access-control-allow-methods', config.ALLOWED_METHODS.join(','));
  headers.set('access-control-allow-headers', config.ALLOWED_HEADERS.join(','));
  headers.set('access-control-expose-headers', config.EXPOSED_HEADERS.join(','));
  headers.set('access-control-max-age', String(config.CORS_MAX_AGE_SECONDS));

  if (config.CORS_ALLOW_CREDENTIALS) {
    headers.set('access-control-allow-credentials', 'true');
  }

  if (origin !== null && isOriginAllowed(origin, config)) {
    headers.set('access-control-allow-origin', config.ALLOWED_ORIGINS.includes('*') ? '*' : origin);
  }

  return headers;
}

function mergeResponseCorsHeaders(
  response: Response,
  origin: string | null,
  config: WorkerConfig,
): Response {
  const headers = new Headers(response.headers);
  const corsHeaders = buildCorsHeaders(origin, config);

  corsHeaders.forEach((value, name) => {
    headers.set(name, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createCorsMiddleware(): MiddlewareHandler<{
  Bindings: HonoBindings;
  Variables: HonoVariables;
}> {
  return async (context: HonoContext, next: Next): Promise<Response> => {
    const config = context.get('workerConfig');
    const requestContext = context.get('requestContext');
    const origin = context.req.header('origin') ?? null;
    const method = context.req.method.toUpperCase();
    const corsHeaders = buildCorsHeaders(origin, config);

    if (origin !== null && !isOriginAllowed(origin, config)) {
      return problemJson({
        status: 403,
        code: 'EDGE_ORIGIN_FORBIDDEN',
        title: 'Origin forbidden',
        detail: 'The request origin is not allowed by the edge gateway.',
        requestId: requestContext.requestId,
        headers: corsHeaders,
      });
    }

    if (config.REQUIRE_ORIGIN_ON_MUTATION && origin === null && MUTATION_METHODS.has(method)) {
      return problemJson({
        status: 403,
        code: 'EDGE_ORIGIN_REQUIRED',
        title: 'Origin required',
        detail: 'Mutating browser-facing requests must include an allowed Origin header.',
        requestId: requestContext.requestId,
        headers: corsHeaders,
      });
    }

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    await next();

    return mergeResponseCorsHeaders(context.res, origin, config);
  };
}
