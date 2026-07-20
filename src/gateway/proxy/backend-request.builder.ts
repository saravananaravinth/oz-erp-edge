// oz-erp-edge/src/gateway/proxy/backend-request.builder.ts
import type { WorkerConfig } from '../../config/index.js';
import { normalizeBaseUrl } from '../../config/index.js';
import type { RequestContext } from '../http/request-context.js';
import type { PreparedRequestBody } from './bounded-request-body.reader.js';
import { buildBackendHeaders } from './request-header.policy.js';

export function buildBackendUrl(
  request: Request,
  backendPath: string,
  config: WorkerConfig,
): string {
  const incomingUrl = new URL(request.url);
  const backendUrl = new URL(`${normalizeBaseUrl(config.CLOUD_RUN_BASE_URL)}${backendPath}`);
  backendUrl.search = incomingUrl.search;
  return backendUrl.toString();
}

export function buildBackendRequest(input: {
  readonly request: Request;
  readonly backendPath: string;
  readonly config: WorkerConfig;
  readonly requestContext: RequestContext;
  readonly invocationToken: string | null;
  readonly preparedBody: PreparedRequestBody;
}): Request {
  return new Request(buildBackendUrl(input.request, input.backendPath, input.config), {
    method: input.request.method,
    headers: buildBackendHeaders({
      request: input.request,
      invocationToken: input.invocationToken,
      requestContext: input.requestContext,
    }),
    body: input.preparedBody.body,
    redirect: 'manual',
  });
}
