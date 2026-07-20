import type { MiddlewareHandler, Next } from 'hono';
import { ZodError } from 'zod';

import { getWorkerConfig } from '../config/index.js';
import { withConfigFailureCorsHeaders } from '../gateway/cors/cors.headers.js';
import { createRequestContext } from '../gateway/http/request-context.js';
import { problemResponse } from '../gateway/http/problem-response.js';
import type { WorkerContext, WorkerHonoEnv } from '../gateway/http/worker-http.types.js';
import type { EdgeLogger } from './observability.types.js';

function getCloudflareColo(request: Request): string | null {
  const cf = (request as Request & { readonly cf?: { readonly colo?: unknown } }).cf;
  return typeof cf?.colo === 'string' ? cf.colo : null;
}

function normalizeOrigin(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function invalidFields(error: unknown): readonly string[] {
  if (!(error instanceof ZodError)) return ['environment'];
  return [
    ...new Set(
      error.issues.map((issue) => (issue.path.length > 0 ? issue.path.join('.') : 'environment')),
    ),
  ].sort();
}

function logCompleted(context: WorkerContext, startedAt: number, logger: EdgeLogger): void {
  const version = context.env.CF_VERSION_METADATA;
  logger.info({
    event: 'edge_request_completed',
    route_class: context.get('routeClass') ?? 'EDGE',
    status: context.res.status,
    duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    backend_duration_ms: context.get('backendDurationMs') ?? null,
    colo: getCloudflareColo(context.req.raw),
    worker_version: version?.id ?? 'local',
    worker_tag: version?.tag ?? context.env.APP_VERSION ?? 'unknown',
  });
}

export function createRequestTelemetryMiddleware(
  logger: EdgeLogger,
): MiddlewareHandler<WorkerHonoEnv> {
  return async (context: WorkerContext, next: Next): Promise<Response> => {
    const startedAt = performance.now();
    const requestContext = createRequestContext(context.req.raw);

    try {
      context.set('workerConfig', getWorkerConfig(context.env));
    } catch (error: unknown) {
      logger.error({
        event: 'edge_config_invalid',
        request_id: requestContext.requestId,
        invalid_fields: invalidFields(error),
      });

      return withConfigFailureCorsHeaders(
        problemResponse({
          status: 503,
          code: 'EDGE_CONFIG_INVALID',
          title: 'Service Unavailable',
          detail:
            error instanceof ZodError
              ? 'The edge gateway environment is invalid.'
              : 'The edge gateway could not start safely.',
          requestId: requestContext.requestId,
        }),
        normalizeOrigin(context.req.header('origin')),
        context.env.ALLOWED_ORIGINS,
      );
    }

    context.set('requestContext', requestContext);
    await next();
    logCompleted(context, startedAt, logger);
    return context.res;
  };
}
