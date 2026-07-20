// oz-erp-edge/src/operations/health/backend-readiness.client.ts
import type { WorkerConfig } from '../../config/index.js';
import { normalizeBaseUrl, shouldUseCloudRunIdToken } from '../../config/index.js';
import { OperationTimeoutError, withTimeout } from '../../shared/async/timeout.js';
import {
  classifyCloudRunTokenFailure,
  type CloudRunTokenFailure,
} from '../../shared/auth/cloud-run-token.error.js';
import type { OutboundFetcher } from '../../shared/http/outbound-fetch.js';
import type { RequestContext } from '../../gateway/http/request-context.js';
import { backendReadyEnvelopeSchema } from './backend-readiness.schema.js';

export type BackendReadinessResult = Readonly<{
  ready: boolean;
  backendStatus: number;
  validation: 'valid' | 'invalid';
}>;

export class ReadinessTokenError extends Error {
  public readonly failure: CloudRunTokenFailure;

  public constructor(failure: CloudRunTokenFailure) {
    super('Cloud Run invocation token is unavailable.');
    this.name = 'ReadinessTokenError';
    this.failure = failure;
  }
}

export class ReadinessTimeoutError extends Error {
  public constructor() {
    super('Backend readiness request timed out.');
    this.name = 'ReadinessTimeoutError';
  }
}

export type BackendReadinessDependencies = Readonly<{
  fetcher: OutboundFetcher;
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
    } catch (error: unknown) {
      throw new ReadinessTokenError(classifyCloudRunTokenFailure(error));
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
