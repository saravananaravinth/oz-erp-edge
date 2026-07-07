// oz-erp-edge/src/proxy.ts
import type { Context } from 'hono';

import type { WorkerConfig, WorkerEnv } from './config.js';
import { normalizeBaseUrl } from './config.js';
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
  'cookie',
  'forwarded',
  'host',
  'x-cloudtasks-queuename',
  'x-cloudtasks-taskexecutioncount',
  'x-cloudtasks-taskname',
  'x-cloudtasks-taskretrycount',
  'x-goog-authenticated-user-email',
  'x-goog-authenticated-user-id',
  'x-oz-task-secret',
  'x-real-ip',
  'x-serverless-authorization',
]);

const FORBIDDEN_RESPONSE_HEADERS = new Set(['server', 'x-powered-by']);
const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);

function pathStartsWithPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function joinPath(prefix: string, pathname: string): string {
  if (prefix.length === 0) {
    return pathname;
  }

  if (pathname === '/') {
    return prefix;
  }

  return `${prefix.replace(/\/+$/u, '')}/${pathname.replace(/^\/+/, '')}`;
}

function stripPublicApiPrefix(pathname: string, publicApiPrefix: string): string | null {
  if (publicApiPrefix.length === 0) {
    return pathname;
  }

  if (pathname === publicApiPrefix) {
    return '/';
  }

  if (!pathname.startsWith(`${publicApiPrefix}/`)) {
    return null;
  }

  const stripped = pathname.slice(publicApiPrefix.length);
  return stripped.length === 0 ? '/' : stripped;
}

export function resolveBackendPath(pathname: string, config: WorkerConfig): string | null {
  const strippedPath = stripPublicApiPrefix(pathname, config.PUBLIC_API_PREFIX);

  if (strippedPath === null) {
    return null;
  }

  const backendPath = joinPath(config.BACKEND_PATH_PREFIX, strippedPath);

  if (config.BLOCKED_BACKEND_PREFIXES.some((prefix) => pathStartsWithPrefix(backendPath, prefix))) {
    return null;
  }

  if (!config.ALLOWED_BACKEND_PREFIXES.some((prefix) => pathStartsWithPrefix(backendPath, prefix))) {
    return null;
  }

  return backendPath;
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

function isAllowedContentType(request: Request): boolean {
  const method = request.method.toUpperCase();

  if (METHODS_WITHOUT_BODY.has(method)) {
    return true;
  }

  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';

  return (
    contentType.includes('application/json') ||
    contentType.includes('multipart/form-data') ||
    contentType.includes('application/x-www-form-urlencoded')
  );
}

function assertRequestBodyAllowed(
  request: Request,
  config: WorkerConfig,
  requestContext: RequestContext,
): Response | null {
  const method = request.method.toUpperCase();

  if (METHODS_WITHOUT_BODY.has(method)) {
    return null;
  }

  if (!isAllowedContentType(request)) {
    return problemJson({
      status: 415,
      code: 'EDGE_UNSUPPORTED_MEDIA_TYPE',
      title: 'Unsupported Media Type',
      detail: 'Only JSON, multipart form, and URL-encoded request bodies are accepted.',
      requestId: requestContext.requestId,
    });
  }

  const contentLength = readContentLength(request);

  if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength > config.MAX_BODY_BYTES)) {
    return problemJson({
      status: 413,
      code: 'EDGE_PAYLOAD_TOO_LARGE',
      title: 'Payload Too Large',
      detail: 'The request body is larger than the edge gateway limit.',
      requestId: requestContext.requestId,
    });
  }

  return null;
}

function getClientIp(request: Request): string | null {
  const value = request.headers.get('cf-connecting-ip');

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

function buildBackendHeaders(request: Request, token: string, requestContext: RequestContext): Headers {
  const headers = new Headers();

  request.headers.forEach((value, name) => {
    const normalizedName = name.toLowerCase();

    if (
      HOP_BY_HOP_HEADERS.has(normalizedName) ||
      FORBIDDEN_INBOUND_HEADERS.has(normalizedName) ||
      normalizedName.startsWith('cf-')
    ) {
      return;
    }

    headers.set(name, value);
  });

  headers.set('x-serverless-authorization', `Bearer ${token}`);
  headers.set('x-request-id', requestContext.requestId);
  headers.set('x-correlation-id', requestContext.correlationId);
  headers.set('x-forwarded-proto', 'https');
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
  const timeout = setTimeout(() => {
    controller.abort('edge_backend_timeout');
  }, timeoutMs);

  try {
    return await fetch(request, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
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
    });
  }

  const bodyValidationResponse = assertRequestBodyAllowed(request, config, requestContext);

  if (bodyValidationResponse !== null) {
    const body = await bodyValidationResponse.text();
    const headers = new Headers(bodyValidationResponse.headers);
    headers.set('x-request-id', requestContext.requestId);

    return new Response(body, {
      status: bodyValidationResponse.status,
      headers,
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
    });
  }

  let token: string;

  try {
    token = await getCloudRunIdToken(config);
  } catch {
    return problemJson({
      status: 503,
      code: 'EDGE_CLOUD_RUN_TOKEN_UNAVAILABLE',
      title: 'Service Unavailable',
      detail: 'The edge gateway could not obtain a Cloud Run invocation token.',
      requestId: requestContext.requestId,
    });
  }

  const backendRequest = new Request(buildBackendUrl(request, backendPath, config), {
    method: request.method,
    headers: buildBackendHeaders(request, token, requestContext),
    body: METHODS_WITHOUT_BODY.has(method) ? null : request.body,
    redirect: 'manual',
  });

  try {
    return sanitizeBackendResponse(await fetchWithTimeout(backendRequest, config.FETCH_TIMEOUT_MS), requestContext);
  } catch {
    return problemJson({
      status: 504,
      code: 'EDGE_BACKEND_TIMEOUT',
      title: 'Gateway Timeout',
      detail: 'The private ERP API did not respond before the edge timeout.',
      requestId: requestContext.requestId,
    });
  }
}
