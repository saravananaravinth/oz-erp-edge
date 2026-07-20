import type { WorkerConfig } from '../../config/index.js';
import { shouldUseCloudRunIdToken } from '../../config/index.js';
import { OperationTimeoutError, withTimeout } from '../../shared/async/timeout.js';
import type { WorkerContext } from '../http/worker-http.types.js';
import { problemResponse } from '../http/problem-response.js';
import { classifyBackendRoute } from '../routing/route-classifier.js';
import { resolveBackendPath } from '../routing/route-exposure.policy.js';
import { buildBackendRequest } from './backend-request.builder.js';
import { sanitizeBackendResponse } from './backend-response.sanitizer.js';
import { prepareRequestBody } from './bounded-request-body.reader.js';

export type EdgeProxyDependencies = Readonly<{
  fetcher: typeof fetch;
  tokenProvider: (config: WorkerConfig) => Promise<string>;
}>;

async function resolveInvocationToken(
  config: WorkerConfig,
  tokenProvider: EdgeProxyDependencies['tokenProvider'],
  requestId: string,
  correlationId: string,
): Promise<Response | string | null> {
  if (!shouldUseCloudRunIdToken(config)) return null;

  try {
    return await tokenProvider(config);
  } catch {
    return problemResponse({
      status: 503,
      code: 'EDGE_CLOUD_RUN_TOKEN_UNAVAILABLE',
      title: 'Service Unavailable',
      detail: 'The edge gateway could not obtain a Cloud Run invocation token.',
      requestId,
      correlationId,
    });
  }
}

export function createEdgeProxyHandler(dependencies: EdgeProxyDependencies) {
  return async (context: WorkerContext): Promise<Response> => {
    const requestContext = context.get('requestContext');
    const config = context.get('workerConfig');
    const request = context.req.raw;
    const method = request.method.toUpperCase();

    if (!config.ALLOWED_METHODS.includes(method)) {
      return problemResponse({
        status: 405,
        code: 'EDGE_METHOD_NOT_ALLOWED',
        title: 'Method Not Allowed',
        detail: 'The HTTP method is not allowed by the edge gateway.',
        requestId: requestContext.requestId,
        correlationId: requestContext.correlationId,
      });
    }

    const backendPath = resolveBackendPath(new URL(request.url).pathname, config);
    if (backendPath === null) {
      return problemResponse({
        status: 404,
        code: 'EDGE_ROUTE_NOT_FOUND',
        title: 'Route not found',
        detail: 'The requested route is not exposed by the edge gateway.',
        requestId: requestContext.requestId,
        correlationId: requestContext.correlationId,
      });
    }

    const routeClass = classifyBackendRoute(method, backendPath);
    context.set('routeClass', routeClass);
    const bodyResult = await prepareRequestBody({ request, routeClass, config, requestContext });
    if (bodyResult instanceof Response) return bodyResult;

    const tokenResult = await resolveInvocationToken(
      config,
      dependencies.tokenProvider,
      requestContext.requestId,
      requestContext.correlationId,
    );
    if (tokenResult instanceof Response) return tokenResult;

    const backendRequest = buildBackendRequest({
      request,
      backendPath,
      config,
      requestContext,
      invocationToken: tokenResult,
      preparedBody: bodyResult,
    });
    const backendStartedAt = performance.now();

    try {
      const backendResponse = await withTimeout({
        timeoutMs: config.FETCH_TIMEOUT_MS,
        timeoutMessage: 'Private backend request timed out.',
        operation: async (signal) =>
          await dependencies.fetcher(backendRequest, {
            signal,
          }),
      });
      context.set(
        'backendDurationMs',
        Math.round((performance.now() - backendStartedAt) * 100) / 100,
      );
      return sanitizeBackendResponse(backendResponse, requestContext);
    } catch (error: unknown) {
      context.set(
        'backendDurationMs',
        Math.round((performance.now() - backendStartedAt) * 100) / 100,
      );
      return problemResponse({
        status: error instanceof OperationTimeoutError ? 504 : 502,
        code:
          error instanceof OperationTimeoutError
            ? 'EDGE_BACKEND_TIMEOUT'
            : 'EDGE_BACKEND_UNAVAILABLE',
        title: error instanceof OperationTimeoutError ? 'Gateway Timeout' : 'Bad Gateway',
        detail:
          error instanceof OperationTimeoutError
            ? 'The private ERP API did not respond before the edge timeout.'
            : 'The private ERP API could not be reached safely.',
        requestId: requestContext.requestId,
        correlationId: requestContext.correlationId,
      });
    }
  };
}
