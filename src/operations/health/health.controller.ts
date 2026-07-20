// oz-erp-edge/src/operations/health/health.controller.ts
import { resolveCloudRunAuthMode } from '../../config/index.js';
import { applySecurityHeaders } from '../../gateway/http/security-headers.js';
import { problemResponse } from '../../gateway/http/problem-response.js';
import type { WorkerContext } from '../../gateway/http/worker-http.types.js';
import {
  checkBackendReadiness,
  ReadinessTimeoutError,
  ReadinessTokenError,
  type BackendReadinessDependencies,
} from './backend-readiness.client.js';

function jsonHeaders(context: WorkerContext): Headers {
  const requestContext = context.get('requestContext');
  const headers = applySecurityHeaders(new Headers());
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-request-id', requestContext.requestId);
  headers.set('x-correlation-id', requestContext.correlationId);
  return headers;
}

export function createHealthController(dependencies: BackendReadinessDependencies) {
  return {
    livez(context: WorkerContext): Response {
      const config = context.get('workerConfig');
      const requestContext = context.get('requestContext');
      const timestamp = new Date().toISOString();
      const version = context.env.CF_VERSION_METADATA?.tag ?? config.APP_VERSION;

      return new Response(
        JSON.stringify({
          success: true,
          data: {
            service: config.APP_NAME,
            status: 'alive',
            version,
            environment: config.APP_ENV,
            cloud_run_auth_mode: resolveCloudRunAuthMode(config),
            timestamp,
          },
          request_id: requestContext.requestId,
          timestamp,
        }),
        { status: 200, headers: jsonHeaders(context) },
      );
    },

    async readyz(context: WorkerContext): Promise<Response> {
      const config = context.get('workerConfig');
      const requestContext = context.get('requestContext');

      try {
        const result = await checkBackendReadiness({ config, requestContext, dependencies });
        const timestamp = new Date().toISOString();
        return new Response(
          JSON.stringify({
            success: result.ready,
            data: {
              service: config.APP_NAME,
              status: result.ready ? 'ready' : 'not_ready',
              backend_status: result.backendStatus,
              backend_contract: result.validation,
              cloud_run_auth_mode: resolveCloudRunAuthMode(config),
              timestamp,
            },
            request_id: requestContext.requestId,
            timestamp,
          }),
          { status: result.ready ? 200 : 503, headers: jsonHeaders(context) },
        );
      } catch (error: unknown) {
        if (error instanceof ReadinessTokenError) {
          context.set('tokenFailure', error.failure);
        }
        const classification =
          error instanceof ReadinessTimeoutError
            ? {
                code: 'EDGE_BACKEND_READINESS_TIMEOUT',
                detail: 'The private ERP API readiness check timed out.',
              }
            : error instanceof ReadinessTokenError
              ? {
                  code: 'EDGE_CLOUD_RUN_TOKEN_UNAVAILABLE',
                  detail: 'The edge gateway could not obtain a Cloud Run invocation token.',
                }
              : {
                  code: 'EDGE_BACKEND_READINESS_UNAVAILABLE',
                  detail: 'The edge gateway could not verify private ERP API readiness.',
                };

        return problemResponse({
          status: 503,
          code: classification.code,
          title: 'Service Unavailable',
          detail: classification.detail,
          requestId: requestContext.requestId,
          correlationId: requestContext.correlationId,
        });
      }
    },
  } as const;
}
