// oz-erp-edge/src/health.ts
import type { Context } from 'hono';
import { z } from 'zod';

import type { WorkerConfig, WorkerEnv } from './config.js';
import { normalizeBaseUrl, resolveCloudRunAuthMode, shouldUseCloudRunIdToken } from './config.js';
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

const dependencyResultSchema = z
  .object({
    name: z.enum(['postgres', 'redis']),
    status: z.enum(['up', 'down']),
    latency_ms: z.number().nonnegative(),
    error: z.enum(['dependency_timeout', 'dependency_unavailable']).optional(),
  })
  .strict();

const backendReadyEnvelopeSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        service: z.string().min(1).max(128),
        status: z.enum(['ready', 'not_ready']),
        uptime_seconds: z.number().nonnegative(),
        timestamp: z.iso.datetime(),
        dependencies: z.array(dependencyResultSchema).max(16),
      })
      .strict(),
    request_id: z.string().min(1).max(128),
    timestamp: z.iso.datetime(),
  })
  .strict();

type Fetcher = typeof fetch;
type TokenProvider = (config: WorkerConfig) => Promise<string>;

export type BackendReadinessResult = Readonly<{
  ready: boolean;
  backendStatus: number;
  validation: 'valid' | 'invalid';
}>;

class ReadinessTokenError extends Error {
  public constructor() {
    super('Cloud Run invocation token is unavailable.');
    this.name = 'ReadinessTokenError';
  }
}

class ReadinessTimeoutError extends Error {
  public constructor() {
    super('Backend readiness request timed out.');
    this.name = 'ReadinessTimeoutError';
  }
}

function createTimeoutState(
  timeoutMs: number,
  controller: AbortController,
  error: Error,
): Readonly<{ promise: Promise<never>; cancel: () => void }> {
  let rejectTimeout: ((reason: Error) => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const handle = setTimeout(() => {
    controller.abort();
    rejectTimeout?.(error);
  }, timeoutMs);

  return {
    promise,
    cancel: () => {
      clearTimeout(handle);
    },
  };
}

function buildJsonHeaders(requestContext: RequestContext): Headers {
  const headers = applySecurityHeaders(new Headers());
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-request-id', requestContext.requestId);
  headers.set('x-correlation-id', requestContext.correlationId);

  return headers;
}

function buildReadyzBackendHeaders(requestContext: RequestContext): Headers {
  const headers = new Headers();
  headers.set('accept', 'application/json');
  headers.set('x-request-id', requestContext.requestId);
  headers.set('x-correlation-id', requestContext.correlationId);
  headers.set('x-oz-edge-gateway', 'cloudflare-worker');

  return headers;
}

async function fetchWithTimeout(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutState = createTimeoutState(timeoutMs, controller, new ReadinessTimeoutError());

  try {
    return await Promise.race([
      fetcher(input, {
        ...init,
        signal: controller.signal,
      }),
      timeoutState.promise,
    ]);
  } finally {
    timeoutState.cancel();
  }
}

export async function checkBackendReadiness(input: {
  readonly config: WorkerConfig;
  readonly requestContext: RequestContext;
  readonly fetcher?: Fetcher;
  readonly tokenProvider?: TokenProvider;
}): Promise<BackendReadinessResult> {
  const backendHeaders = buildReadyzBackendHeaders(input.requestContext);

  if (shouldUseCloudRunIdToken(input.config)) {
    try {
      const token = await (input.tokenProvider ?? getCloudRunIdToken)(input.config);
      backendHeaders.set('x-serverless-authorization', `Bearer ${token}`);
    } catch {
      throw new ReadinessTokenError();
    }
  }

  const backendReadyUrl = `${normalizeBaseUrl(input.config.CLOUD_RUN_BASE_URL)}${input.config.BACKEND_READINESS_PATH}`;
  const response = await fetchWithTimeout(
    input.fetcher ?? fetch,
    backendReadyUrl,
    {
      method: 'GET',
      headers: backendHeaders,
      redirect: 'manual',
    },
    input.config.READINESS_TIMEOUT_MS,
  );

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return {
      ready: false,
      backendStatus: response.status,
      validation: 'invalid',
    };
  }

  const parsed = backendReadyEnvelopeSchema.safeParse(body);

  return {
    ready: response.status === 200 && parsed.success && parsed.data.data.status === 'ready',
    backendStatus: response.status,
    validation: parsed.success ? 'valid' : 'invalid',
  };
}

export function livez(context: HonoContext): Response {
  const config = context.get('workerConfig');
  const requestContext = context.get('requestContext');
  const timestamp = new Date().toISOString();

  return new Response(
    JSON.stringify({
      success: true,
      data: {
        service: config.APP_NAME,
        status: 'alive',
        version: config.APP_VERSION,
        environment: config.APP_ENV,
        cloud_run_auth_mode: resolveCloudRunAuthMode(config),
        timestamp,
      },
      request_id: requestContext.requestId,
      timestamp,
    }),
    {
      status: 200,
      headers: buildJsonHeaders(requestContext),
    },
  );
}

export async function readyz(context: HonoContext): Promise<Response> {
  const config = context.get('workerConfig');
  const requestContext = context.get('requestContext');
  let result: BackendReadinessResult;

  try {
    result = await checkBackendReadiness({
      config,
      requestContext,
    });
  } catch (error: unknown) {
    if (error instanceof ReadinessTimeoutError) {
      return problemJson({
        status: 503,
        code: 'EDGE_BACKEND_READINESS_TIMEOUT',
        title: 'Service Unavailable',
        detail: 'The private ERP API readiness check timed out.',
        requestId: requestContext.requestId,
        correlationId: requestContext.correlationId,
      });
    }

    if (error instanceof ReadinessTokenError) {
      return problemJson({
        status: 503,
        code: 'EDGE_CLOUD_RUN_TOKEN_UNAVAILABLE',
        title: 'Service Unavailable',
        detail: 'The edge gateway could not obtain a Cloud Run invocation token.',
        requestId: requestContext.requestId,
        correlationId: requestContext.correlationId,
      });
    }

    return problemJson({
      status: 503,
      code: 'EDGE_BACKEND_READINESS_UNAVAILABLE',
      title: 'Service Unavailable',
      detail: 'The edge gateway could not verify private ERP API readiness.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  }

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
    {
      status: result.ready ? 200 : 503,
      headers: buildJsonHeaders(requestContext),
    },
  );
}
