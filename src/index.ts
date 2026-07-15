// oz-erp-edge/src/index.ts
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { ZodError } from 'zod';

import { createCorsMiddleware, withConfigFailureCorsHeaders } from './cors.js';
import type { WorkerConfig, WorkerEnv } from './config.js';
import { getWorkerConfig } from './config.js';
import { livez, readyz } from './health.js';
import { problemJson } from './problem.js';
import { proxyToCloudRun } from './proxy.js';
import type { RequestContext } from './request-context.js';
import { createRequestContext } from './request-context.js';

type HonoVariables = Readonly<{
  requestContext: RequestContext;
  workerConfig: WorkerConfig;
  routeClass?: string;
  backendDurationMs?: number;
}>;

type HonoAppEnv = {
  Bindings: WorkerEnv;
  Variables: HonoVariables;
};

type HonoContext = Context<HonoAppEnv>;

function normalizeRequestOrigin(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';

  return normalized.length > 0 ? normalized : null;
}

function logInvalidConfig(error: unknown, requestContext: RequestContext): void {
  const invalidFields =
    error instanceof ZodError
      ? [
          ...new Set(
            error.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : 'environment',
            ),
          ),
        ].sort()
      : ['environment'];

  // eslint-disable-next-line no-console -- Workers Logs needs a redacted structured startup error.
  console.error(
    JSON.stringify({
      event: 'edge_config_invalid',
      request_id: requestContext.requestId,
      invalid_fields: invalidFields,
    }),
  );
}

function logRequestCompleted(context: HonoContext, startedAt: number): void {
  const version = context.env.CF_VERSION_METADATA;

  // eslint-disable-next-line no-console -- Cloudflare sampling is configured in wrangler.jsonc.
  console.log(
    JSON.stringify({
      event: 'edge_request_completed',
      route_class: context.get('routeClass') ?? 'EDGE',
      status: context.res.status,
      duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      backend_duration_ms: context.get('backendDurationMs') ?? null,
      colo: context.req.raw.cf?.colo ?? null,
      worker_version: version?.id ?? 'local',
      worker_tag: version?.tag ?? context.env.APP_VERSION ?? 'unknown',
    }),
  );
}

const app = new Hono<HonoAppEnv>({
  strict: true,
});

app.use('*', async (context: HonoContext, next: Next): Promise<Response> => {
  const startedAt = performance.now();
  const requestContext = createRequestContext(context.req.raw);
  let config: WorkerConfig;

  try {
    config = getWorkerConfig(context.env);
  } catch (error: unknown) {
    const detail =
      error instanceof ZodError
        ? 'The edge gateway environment is invalid.'
        : 'The edge gateway could not start safely.';

    logInvalidConfig(error, requestContext);

    const response = problemJson({
      status: 503,
      code: 'EDGE_CONFIG_INVALID',
      title: 'Service Unavailable',
      detail,
      requestId: requestContext.requestId,
    });

    return withConfigFailureCorsHeaders(
      response,
      normalizeRequestOrigin(context.req.header('origin')),
      context.env.ALLOWED_ORIGINS,
    );
  }

  context.set('requestContext', requestContext);
  context.set('workerConfig', config);

  await next();
  logRequestCompleted(context, startedAt);

  return context.res;
});

app.use('*', createCorsMiddleware());

app.get('/livez', livez);
app.get('/readyz', readyz);
app.all('*', proxyToCloudRun);

app.notFound((context: HonoContext): Response => {
  const requestContext = context.get('requestContext');

  return problemJson({
    status: 404,
    code: 'EDGE_ROUTE_NOT_FOUND',
    title: 'Route not found',
    detail: 'The requested route is not exposed by the edge gateway.',
    requestId: requestContext.requestId,
  });
});

app.onError((_error: Error, context: HonoContext): Response => {
  const requestContext = context.get('requestContext');

  return problemJson({
    status: 502,
    code: 'EDGE_UNEXPECTED_ERROR',
    title: 'Bad Gateway',
    detail: 'The edge gateway failed before the request reached a safe backend state.',
    requestId: requestContext.requestId,
  });
});

export default app;
