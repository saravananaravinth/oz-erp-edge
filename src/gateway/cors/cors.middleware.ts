// oz-erp-edge/src/gateway/cors/cors.middleware.ts
import type { MiddlewareHandler, Next } from 'hono';

import type { WorkerContext, WorkerHonoEnv } from '../http/worker-http.types.js';
import { problemResponse } from '../http/problem-response.js';
import { shouldRequireOrigin } from '../routing/origin-requirement.policy.js';
import { resolveBackendPath } from '../routing/route-exposure.policy.js';
import { buildCorsHeaders, isOriginAllowed, withCorsHeaders } from './cors.headers.js';
import { validateCorsPreflight } from './cors-request.validator.js';

function optionalHeader(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function failure(
  context: WorkerContext,
  origin: string | null,
  input: Readonly<{
    status: 400 | 403 | 405;
    code: string;
    title: string;
    detail: string;
  }>,
): Response {
  const requestContext = context.get('requestContext');
  return withCorsHeaders(
    problemResponse({
      ...input,
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    }),
    origin,
    context.get('workerConfig'),
  );
}

export function createCorsMiddleware(): MiddlewareHandler<WorkerHonoEnv> {
  return async (context: WorkerContext, next: Next): Promise<Response> => {
    const config = context.get('workerConfig');
    const origin = optionalHeader(context.req.header('origin'));
    const method = context.req.method.toUpperCase();
    const backendPath = resolveBackendPath(context.req.path, config);

    if (!isOriginAllowed(origin, config)) {
      return failure(context, origin, {
        status: 403,
        code: 'EDGE_ORIGIN_FORBIDDEN',
        title: 'Origin forbidden',
        detail: 'The request origin is not allowed by the edge gateway.',
      });
    }

    if (
      shouldRequireOrigin({
        method,
        backendPath,
        origin,
        requireOriginOnMutation: config.REQUIRE_ORIGIN_ON_MUTATION,
      })
    ) {
      return failure(context, origin, {
        status: 403,
        code: 'EDGE_ORIGIN_REQUIRED',
        title: 'Origin required',
        detail: 'Mutating browser-facing requests must include an allowed Origin header.',
      });
    }

    if (method === 'OPTIONS') {
      const preflightFailure = validateCorsPreflight({
        requestedMethod: optionalHeader(context.req.header('access-control-request-method')),
        requestedHeaders: optionalHeader(context.req.header('access-control-request-headers')),
        config,
      });
      if (preflightFailure !== null) return failure(context, origin, preflightFailure);
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(origin, config, { preflight: true }),
      });
    }

    await next();
    const wrapped = withCorsHeaders(context.res, origin, config);
    context.res = wrapped;
    return wrapped;
  };
}
