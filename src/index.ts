// oz-erp-edge/src/index.ts
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { ZodError } from 'zod';

import { createCorsMiddleware } from './cors.js';
import type { WorkerConfig, WorkerEnv } from './config.js';
import { parseWorkerConfig } from './config.js';
import { livez, readyz } from './health.js';
import { problemJson } from './problem.js';
import { proxyToCloudRun } from './proxy.js';
import type { RequestContext } from './request-context.js';
import { createRequestContext } from './request-context.js';

type HonoVariables = Readonly<{
  requestContext: RequestContext;
  workerConfig: WorkerConfig;
}>;

type HonoAppEnv = {
  Bindings: WorkerEnv;
  Variables: HonoVariables;
};

type HonoContext = Context<HonoAppEnv>;

const app = new Hono<HonoAppEnv>({
  strict: true,
});

app.use('*', async (context: HonoContext, next: Next): Promise<Response> => {
  const requestContext = createRequestContext(context.req.raw);
  let config: WorkerConfig;

  try {
    config = parseWorkerConfig(context.env);
  } catch (error: unknown) {
    const detail =
      error instanceof ZodError
        ? 'The edge gateway environment is invalid.'
        : 'The edge gateway could not start safely.';

    return problemJson({
      status: 503,
      code: 'EDGE_CONFIG_INVALID',
      title: 'Service Unavailable',
      detail,
      requestId: requestContext.requestId,
    });
  }

  context.set('requestContext', requestContext);
  context.set('workerConfig', config);

  await next();

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
