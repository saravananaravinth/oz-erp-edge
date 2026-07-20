import type { WorkerConfig } from '../../config/index.js';
import { problemResponse } from '../http/problem-response.js';
import type { RequestContext } from '../http/request-context.js';
import type { BackendRouteClass } from '../routing/route-classifier.js';
import {
  isJsonMediaType,
  parseContentType,
  type ParsedContentType,
} from '../../shared/http/media-type.js';

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);
const WARRANTY_UPLOAD_MULTIPART_MAX_BODY_BYTES = 11 * 1024 * 1024;

export type PreparedRequestBody = Readonly<{
  body: BodyInit | null;
  byteLength: number;
}>;

export type BodyPreparationResult = PreparedRequestBody | Response;

function readContentLength(request: Request): number | null {
  const value = request.headers.get('content-length');
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) return Number.NaN;
  return Number.parseInt(value, 10);
}

function mergeChunks(chunks: readonly Uint8Array[], byteLength: number): ArrayBuffer {
  const buffer = new ArrayBuffer(byteLength);
  const body = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function contentLengthFailure(requestContext: RequestContext): Response {
  return problemResponse({
    status: 400,
    code: 'EDGE_CONTENT_LENGTH_INVALID',
    title: 'Invalid Content-Length',
    detail: 'Content-Length must be a non-negative integer.',
    requestId: requestContext.requestId,
    correlationId: requestContext.correlationId,
  });
}

function payloadTooLarge(requestContext: RequestContext): Response {
  return problemResponse({
    status: 413,
    code: 'EDGE_PAYLOAD_TOO_LARGE',
    title: 'Payload Too Large',
    detail: 'The request body is larger than the edge gateway limit.',
    requestId: requestContext.requestId,
    correlationId: requestContext.correlationId,
  });
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
  if (routeClass === 'RAW_WEBHOOK') return contentType !== null;
  if (routeClass === 'WARRANTY_MULTIPART') {
    return contentType?.mediaType === 'multipart/form-data' && contentType.boundary !== null;
  }
  return (
    contentType !== null &&
    (isJsonMediaType(contentType.mediaType) ||
      contentType.mediaType === 'application/x-www-form-urlencoded')
  );
}

async function readBoundedBody(
  request: Request,
  maxBodyBytes: number,
  requestContext: RequestContext,
): Promise<BodyPreparationResult> {
  if (request.body === null) return { body: null, byteLength: 0 };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;

      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) {
        return problemResponse({
          status: 400,
          code: 'EDGE_REQUEST_BODY_INVALID',
          title: 'Invalid request body',
          detail: 'The edge gateway received an unsupported request-body chunk.',
          requestId: requestContext.requestId,
          correlationId: requestContext.correlationId,
        });
      }

      byteLength += chunk.byteLength;
      if (byteLength > maxBodyBytes) {
        await reader.cancel('edge_payload_too_large');
        return payloadTooLarge(requestContext);
      }
      chunks.push(chunk);
    }
  } catch {
    return problemResponse({
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

export async function prepareRequestBody(input: {
  readonly request: Request;
  readonly routeClass: BackendRouteClass;
  readonly config: WorkerConfig;
  readonly requestContext: RequestContext;
}): Promise<BodyPreparationResult> {
  const method = input.request.method.toUpperCase();
  const contentEncoding = input.request.headers.get('content-encoding')?.trim().toLowerCase();

  if (contentEncoding !== undefined && contentEncoding !== 'identity') {
    return problemResponse({
      status: 415,
      code: 'EDGE_UNSUPPORTED_CONTENT_ENCODING',
      title: 'Unsupported Content Encoding',
      detail: 'Compressed request bodies are not accepted by the edge gateway.',
      requestId: input.requestContext.requestId,
      correlationId: input.requestContext.correlationId,
    });
  }

  if (METHODS_WITHOUT_BODY.has(method)) return { body: null, byteLength: 0 };

  const maxBodyBytes = resolveMaxRequestBodyBytes(input.routeClass, input.config);
  const declaredContentLength = readContentLength(input.request);
  if (declaredContentLength !== null && !Number.isFinite(declaredContentLength)) {
    return contentLengthFailure(input.requestContext);
  }
  if (declaredContentLength !== null && declaredContentLength > maxBodyBytes) {
    return payloadTooLarge(input.requestContext);
  }
  if (input.request.body === null || declaredContentLength === 0) {
    return { body: null, byteLength: 0 };
  }

  const rawContentType = input.request.headers.get('content-type');
  const contentType = parseContentType(rawContentType);
  if (!(input.routeClass === 'RAW_WEBHOOK' && rawContentType === null)) {
    if (!isContentTypeAllowed(input.routeClass, contentType)) {
      const detail =
        input.routeClass === 'WARRANTY_MULTIPART'
          ? 'Warranty file upload requires multipart/form-data with a valid boundary.'
          : input.routeClass === 'RAW_WEBHOOK'
            ? 'The webhook Content-Type header is malformed.'
            : 'Only JSON and URL-encoded request bodies are accepted for this ERP route.';

      return problemResponse({
        status: 415,
        code: 'EDGE_UNSUPPORTED_MEDIA_TYPE',
        title: 'Unsupported Media Type',
        detail,
        requestId: input.requestContext.requestId,
        correlationId: input.requestContext.correlationId,
      });
    }
  }

  if (declaredContentLength !== null) {
    return { body: input.request.body, byteLength: declaredContentLength };
  }

  return await readBoundedBody(input.request, maxBodyBytes, input.requestContext);
}

export { parseContentType } from '../../shared/http/media-type.js';
