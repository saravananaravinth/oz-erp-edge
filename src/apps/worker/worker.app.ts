// oz-erp-edge/src/apps/worker/worker.app.ts
import { Hono } from 'hono';

import { createCorsMiddleware } from '../../gateway/cors/cors.middleware.js';
import { problemResponse } from '../../gateway/http/problem-response.js';
import type { WorkerContext, WorkerHonoEnv } from '../../gateway/http/worker-http.types.js';
import { createEdgeProxyHandler } from '../../gateway/proxy/edge-proxy.handler.js';
import { createRequestTelemetryMiddleware } from '../../observability/request-telemetry.middleware.js';
import { createHealthController } from '../../operations/health/index.js';
import type { WorkerDependencies } from './worker.types.js';

export function createWorkerApp(dependencies: WorkerDependencies): Hono<WorkerHonoEnv> {
  const app = new Hono<WorkerHonoEnv>({ strict: true });
  const health = createHealthController({
    fetcher: dependencies.fetcher,
    tokenProvider: dependencies.tokenProvider,
  });
  const proxy = createEdgeProxyHandler({
    fetcher: dependencies.fetcher,
    tokenProvider: dependencies.tokenProvider,
  });

  app.use('*', createRequestTelemetryMiddleware(dependencies.logger));
  app.use('*', createCorsMiddleware());
  app.get('/livez', (context) => health.livez(context));
  app.get('/readyz', async (context) => await health.readyz(context));
  app.all('*', proxy);

  app.notFound((context: WorkerContext): Response => {
    const requestContext = context.get('requestContext');
    return problemResponse({
      status: 404,
      code: 'EDGE_ROUTE_NOT_FOUND',
      title: 'Route not found',
      detail: 'The requested route is not exposed by the edge gateway.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  });

  app.onError((_error: Error, context: WorkerContext): Response => {
    const requestContext = context.get('requestContext');
    return problemResponse({
      status: 502,
      code: 'EDGE_UNEXPECTED_ERROR',
      title: 'Bad Gateway',
      detail: 'The edge gateway failed before the request reached a safe backend state.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  });

  return app;
}
