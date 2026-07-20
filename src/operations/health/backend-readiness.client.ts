import type { WorkerConfig } from '../../config/index.js';
import { normalizeBaseUrl, shouldUseCloudRunIdToken } from '../../config/index.js';
import { OperationTimeoutError, withTimeout } from '../../shared/async/timeout.js';
import type { RequestContext } from '../../gateway/http/request-context.js';
import { backendReadyEnvelopeSchema } from './backend-readiness.schema.js';

export type BackendReadinessResult = Readonly<{
  ready: boolean;
  backendStatus: number;
  validation: 'valid' | 'invalid';
}>;

export class ReadinessTokenError extends Error {
  public constructor() {
    super('Cloud Run invocation token is unavailable.');
    this.name = 'ReadinessTokenError';
  }
}

export class ReadinessTimeoutError extends Error {
  public constructor() {
    super('Backend readiness request timed out.');
    this.name = 'ReadinessTimeoutError';
  }
}

export type BackendReadinessDependencies = Readonly<{
  fetcher: typeof fetch;
  tokenProvider: (config: WorkerConfig) => Promise<string>;
}>;

export async function checkBackendReadiness(input: {
  readonly config: WorkerConfig;
  readonly requestContext: RequestContext;
  readonly dependencies: BackendReadinessDependencies;
}): Promise<BackendReadinessResult> {
  const headers = new Headers({ accept: 'application/json' });
  headers.set('x-request-id', input.requestContext.requestId);
  headers.set('x-correlation-id', input.requestContext.correlationId);
  headers.set('x-oz-edge-gateway', 'cloudflare-worker');

  if (shouldUseCloudRunIdToken(input.config)) {
    try {
      headers.set(
        'x-serverless-authorization',
        `Bearer ${await input.dependencies.tokenProvider(input.config)}`,
      );
    } catch {
      throw new ReadinessTokenError();
    }
  }

  let response: Response;
  try {
    response = await withTimeout({
      timeoutMs: input.config.READINESS_TIMEOUT_MS,
      timeoutMessage: 'Backend readiness request timed out.',
      operation: async (signal) =>
        await input.dependencies.fetcher(
          `${normalizeBaseUrl(input.config.CLOUD_RUN_BASE_URL)}${input.config.BACKEND_READINESS_PATH}`,
          { method: 'GET', headers, redirect: 'manual', signal },
        ),
    });
  } catch (error: unknown) {
    if (error instanceof OperationTimeoutError) throw new ReadinessTimeoutError();
    throw error;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ready: false, backendStatus: response.status, validation: 'invalid' };
  }

  const parsed = backendReadyEnvelopeSchema.safeParse(body);
  return {
    ready: response.status === 200 && parsed.success && parsed.data.data.status === 'ready',
    backendStatus: response.status,
    validation: parsed.success ? 'valid' : 'invalid',
  };
}
