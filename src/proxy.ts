// oz-erp-edge/src/proxy.ts
import type { Context } from 'hono';

import type { WorkerConfig, WorkerEnv } from './config.js';
import { normalizeBaseUrl, shouldUseCloudRunIdToken } from './config.js';
import { getCloudRunIdToken } from './gcp-id-token.js';
import { problemJson } from './problem.js';
import type { RequestContext } from './request-context.js';
import {
  classifyBackendRoute,
  resolveBackendPath,
  type BackendRouteClass,
} from './route-policy.js';
import { applySecurityHeaders } from './security.js';

type HonoVariables = Readonly<{
  requestContext: RequestContext;
  workerConfig: WorkerConfig;
}>;

type HonoContext = Context<{
  Bindings: WorkerEnv;
  Variables: HonoVariables;
}>;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const FORBIDDEN_INBOUND_HEADERS = new Set([
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'content-encoding',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'x-goog-authenticated-user-email',
  'x-goog-authenticated-user-id',
  'x-oz-edge-gateway',
  'x-oz-task-secret',
  'x-real-ip',
  'x-serverless-authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

const FORBIDDEN_RESPONSE_HEADERS = new Set(['server', 'x-powered-by']);
const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);
const WARRANTY_UPLOAD_MULTIPART_MAX_BODY_BYTES = 11 * 1024 * 1024;
const MEDIA_TYPE_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const JSON_MEDIA_TYPE_PATTERN = /^application\/(?:json|[!#$%&'*+.^_`|~0-9A-Za-z-]+\+json)$/u;
const MULTIPART_BOUNDARY_PATTERN = /^[0-9A-Za-z'()+_,./:=?-]{1,70}$/u;

export { resolveBackendPath } from './route-policy.js';

export type ParsedContentType = Readonly<{
  mediaType: string;
  boundary: string | null;
}>;

type PreparedRequestBody = Readonly<{
  body: Uint8Array | null;
  byteLength: number;
}>;

type BodyPreparationResult = PreparedRequestBody | Response;

class BackendTimeoutError extends Error {
  public constructor() {
    super('Private backend request timed out.');
    this.name = 'BackendTimeoutError';
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

function isForbiddenInboundHeader(normalizedName: string): boolean {
  return (
    HOP_BY_HOP_HEADERS.has(normalizedName) ||
    FORBIDDEN_INBOUND_HEADERS.has(normalizedName) ||
    normalizedName.startsWith('cf-') ||
    normalizedName.startsWith('x-cloudtasks-') ||
    normalizedName.startsWith('x-goog-') ||
    normalizedName.startsWith('x-appengine-') ||
    normalizedName.startsWith('x-envoy-')
  );
}

function parseBoundaryParameter(parts: readonly string[]): string | null {
  for (const rawPart of parts) {
    const separatorIndex = rawPart.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const name = rawPart.slice(0, separatorIndex).trim().toLowerCase();

    if (name !== 'boundary') {
      continue;
    }

    const rawValue = rawPart.slice(separatorIndex + 1).trim();
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2
        ? rawValue.slice(1, -1)
        : rawValue;

    return MULTIPART_BOUNDARY_PATTERN.test(value) ? value : null;
  }

  return null;
}

export function parseContentType(value: string | null): ParsedContentType | null {
  if (value === null) {
    return null;
  }

  const parts = value.split(';');
  const mediaType = parts[0]?.trim().toLowerCase() ?? '';

  if (!MEDIA_TYPE_PATTERN.test(mediaType)) {
    return null;
  }

  return {
    mediaType,
    boundary: mediaType === 'multipart/form-data' ? parseBoundaryParameter(parts.slice(1)) : null,
  };
}

export function resolveMaxRequestBodyBytes(
  routeClass: BackendRouteClass,
  config: WorkerConfig,
): number {
  return routeClass === 'WARRANTY_MULTIPART'
    ? WARRANTY_UPLOAD_MULTIPART_MAX_BODY_BYTES
    : config.MAX_BODY_BYTES;
}

export function isContentTypeAllowed(
  routeClass: BackendRouteClass,
  contentType: ParsedContentType | null,
): boolean {
  if (routeClass === 'RAW_WEBHOOK') {
    return contentType !== null;
  }

  if (routeClass === 'WARRANTY_MULTIPART') {
    return contentType?.mediaType === 'multipart/form-data' && contentType.boundary !== null;
  }

  if (contentType === null) {
    return false;
  }

  return (
    JSON_MEDIA_TYPE_PATTERN.test(contentType.mediaType) ||
    contentType.mediaType === 'application/x-www-form-urlencoded'
  );
}

function readContentLength(request: Request): number | null {
  const contentLength = request.headers.get('content-length');

  if (contentLength === null) {
    return null;
  }

  if (!/^\d+$/u.test(contentLength)) {
    return Number.NaN;
  }

  return Number.parseInt(contentLength, 10);
}

function mergeChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const body = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

async function readBoundedBody(
  request: Request,
  maxBodyBytes: number,
  requestContext: RequestContext,
): Promise<BodyPreparationResult> {
  const declaredContentLength = readContentLength(request);

  if (declaredContentLength !== null && !Number.isFinite(declaredContentLength)) {
    return problemJson({
      status: 400,
      code: 'EDGE_CONTENT_LENGTH_INVALID',
      title: 'Invalid Content-Length',
      detail: 'Content-Length must be a non-negative integer.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  }

  if (declaredContentLength !== null && declaredContentLength > maxBodyBytes) {
    return problemJson({
      status: 413,
      code: 'EDGE_PAYLOAD_TOO_LARGE',
      title: 'Payload Too Large',
      detail: 'The request body is larger than the edge gateway limit.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  }

  if (request.body === null || declaredContentLength === 0) {
    return {
      body: null,
      byteLength: 0,
    };
  }

  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    for (;;) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      byteLength += result.value.byteLength;

      if (byteLength > maxBodyBytes) {
        await reader.cancel('edge_payload_too_large');

        return problemJson({
          status: 413,
          code: 'EDGE_PAYLOAD_TOO_LARGE',
          title: 'Payload Too Large',
          detail: 'The request body is larger than the edge gateway limit.',
          requestId: requestContext.requestId,
          correlationId: requestContext.correlationId,
        });
      }

      chunks.push(result.value);
    }
  } catch {
    return problemJson({
      status: 400,
      code: 'EDGE_REQUEST_BODY_INVALID',
      title: 'Invalid request body',
      detail: 'The edge gateway could not read the request body safely.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  } finally {
    reader.releaseLock();
  }

  return {
    body: byteLength === 0 ? null : mergeChunks(chunks, byteLength),
    byteLength,
  };
}

async function prepareRequestBody(
  request: Request,
  routeClass: BackendRouteClass,
  config: WorkerConfig,
  requestContext: RequestContext,
): Promise<BodyPreparationResult> {
  const method = request.method.toUpperCase();
  const contentEncoding = request.headers.get('content-encoding')?.trim().toLowerCase();

  if (contentEncoding !== undefined && contentEncoding !== 'identity') {
    return problemJson({
      status: 415,
      code: 'EDGE_UNSUPPORTED_CONTENT_ENCODING',
      title: 'Unsupported Content Encoding',
      detail: 'Compressed request bodies are not accepted by the edge gateway.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  }

  if (METHODS_WITHOUT_BODY.has(method)) {
    return {
      body: null,
      byteLength: 0,
    };
  }

  const prepared = await readBoundedBody(
    request,
    resolveMaxRequestBodyBytes(routeClass, config),
    requestContext,
  );

  if (prepared instanceof Response || prepared.byteLength === 0) {
    return prepared;
  }

  const rawContentType = request.headers.get('content-type');
  const contentType = parseContentType(rawContentType);

  if (routeClass === 'RAW_WEBHOOK' && rawContentType === null) {
    return prepared;
  }

  if (!isContentTypeAllowed(routeClass, contentType)) {
    const detail =
      routeClass === 'WARRANTY_MULTIPART'
        ? 'Warranty file upload requires multipart/form-data with a valid boundary.'
        : routeClass === 'RAW_WEBHOOK'
          ? 'The webhook Content-Type header is malformed.'
          : 'Only JSON and URL-encoded request bodies are accepted for this ERP route.';

    return problemJson({
      status: 415,
      code: 'EDGE_UNSUPPORTED_MEDIA_TYPE',
      title: 'Unsupported Media Type',
      detail,
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  }

  return prepared;
}

function getClientIp(request: Request): string | null {
  const value = request.headers.get('cf-connecting-ip');

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

function resolveForwardedProto(request: Request): 'http' | 'https' {
  return new URL(request.url).protocol === 'http:' ? 'http' : 'https';
}

function buildBackendHeaders(
  request: Request,
  token: string | null,
  requestContext: RequestContext,
): Headers {
  const headers = new Headers();

  request.headers.forEach((value, name) => {
    const normalizedName = name.toLowerCase();

    if (!isForbiddenInboundHeader(normalizedName)) {
      headers.set(name, value);
    }
  });

  if (token !== null) {
    headers.set('x-serverless-authorization', `Bearer ${token}`);
  }

  headers.set('x-request-id', requestContext.requestId);
  headers.set('x-correlation-id', requestContext.correlationId);
  headers.set('x-forwarded-proto', resolveForwardedProto(request));
  headers.set('x-oz-edge-gateway', 'cloudflare-worker');

  const clientIp = getClientIp(request);

  if (clientIp !== null) {
    headers.set('x-forwarded-for', clientIp);
  }

  return headers;
}

function buildBackendUrl(request: Request, backendPath: string, config: WorkerConfig): string {
  const incomingUrl = new URL(request.url);
  const backendUrl = new URL(`${normalizeBaseUrl(config.CLOUD_RUN_BASE_URL)}${backendPath}`);
  backendUrl.search = incomingUrl.search;

  return backendUrl.toString();
}

async function fetchWithTimeout(request: Request, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutState = createTimeoutState(timeoutMs, controller, new BackendTimeoutError());

  try {
    return await Promise.race([
      fetch(request, {
        signal: controller.signal,
      }),
      timeoutState.promise,
    ]);
  } finally {
    timeoutState.cancel();
  }
}

function sanitizeBackendResponse(response: Response, requestContext: RequestContext): Response {
  const headers = new Headers(response.headers);

  for (const name of FORBIDDEN_RESPONSE_HEADERS) {
    headers.delete(name);
  }

  headers.set('x-request-id', requestContext.requestId);
  headers.set('x-correlation-id', requestContext.correlationId);
  applySecurityHeaders(headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function resolveBackendInvocationToken(
  config: WorkerConfig,
  requestContext: RequestContext,
): Promise<Response | string | null> {
  if (!shouldUseCloudRunIdToken(config)) {
    return null;
  }

  try {
    return await getCloudRunIdToken(config);
  } catch {
    return problemJson({
      status: 503,
      code: 'EDGE_CLOUD_RUN_TOKEN_UNAVAILABLE',
      title: 'Service Unavailable',
      detail: 'The edge gateway could not obtain a Cloud Run invocation token.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  }
}

export async function proxyToCloudRun(context: HonoContext): Promise<Response> {
  const requestContext = context.get('requestContext');
  const config = context.get('workerConfig');
  const request = context.req.raw;
  const method = request.method.toUpperCase();

  if (!config.ALLOWED_METHODS.includes(method)) {
    return problemJson({
      status: 405,
      code: 'EDGE_METHOD_NOT_ALLOWED',
      title: 'Method Not Allowed',
      detail: 'The HTTP method is not allowed by the edge gateway.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  }

  const incomingUrl = new URL(request.url);
  const backendPath = resolveBackendPath(incomingUrl.pathname, config);

  if (backendPath === null) {
    return problemJson({
      status: 404,
      code: 'EDGE_ROUTE_NOT_FOUND',
      title: 'Route not found',
      detail: 'The requested route is not exposed by the edge gateway.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  }

  const routeClass = classifyBackendRoute(method, backendPath);
  const bodyResult = await prepareRequestBody(request, routeClass, config, requestContext);

  if (bodyResult instanceof Response) {
    return bodyResult;
  }

  const tokenResult = await resolveBackendInvocationToken(config, requestContext);

  if (tokenResult instanceof Response) {
    return tokenResult;
  }

  const backendRequest = new Request(buildBackendUrl(request, backendPath, config), {
    method: request.method,
    headers: buildBackendHeaders(request, tokenResult, requestContext),
    body: bodyResult.body,
    redirect: 'manual',
  });

  try {
    return sanitizeBackendResponse(
      await fetchWithTimeout(backendRequest, config.FETCH_TIMEOUT_MS),
      requestContext,
    );
  } catch (error: unknown) {
    if (error instanceof BackendTimeoutError) {
      return problemJson({
        status: 504,
        code: 'EDGE_BACKEND_TIMEOUT',
        title: 'Gateway Timeout',
        detail: 'The private ERP API did not respond before the edge timeout.',
        requestId: requestContext.requestId,
        correlationId: requestContext.correlationId,
      });
    }

    return problemJson({
      status: 502,
      code: 'EDGE_BACKEND_UNAVAILABLE',
      title: 'Bad Gateway',
      detail: 'The private ERP API could not be reached safely.',
      requestId: requestContext.requestId,
      correlationId: requestContext.correlationId,
    });
  }
}
