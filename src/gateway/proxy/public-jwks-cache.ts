// oz-erp-edge/src/gateway/proxy/public-jwks-cache.ts
import { z } from 'zod';

import type { WorkerContext } from '../http/worker-http.types.js';
import { sanitizeBackendResponse } from './backend-response.sanitizer.js';

// Cache *only* an anonymous public signing-key document. POP-local cache entries
// cannot authorize any ERP operation, and they must never store request metadata.
const PUBLIC_JWKS_PATH = '/erp/auth/.well-known/jwks.json';
const MAX_PUBLIC_JWKS_BYTES = 64 * 1024;
const PUBLIC_JWKS_TTL_SECONDS = 60;
const PUBLIC_JWKS_CACHE_NAME = 'oz-edge-public-jwks-v2';
const CACHE_KEY_QUERY = '__oz_edge_jwks_public_v2';
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

const publicSigningKeySchema = z
  .object({
    kty: z.literal('RSA'),
    kid: z.string().min(1).max(256),
    alg: z.enum(['RS256', 'RS384', 'RS512']),
    use: z.literal('sig'),
    key_ops: z.tuple([z.literal('verify')]),
    n: z.string().min(1).max(16_384).regex(BASE64URL),
    e: z.string().min(1).max(64).regex(BASE64URL),
  })
  .strict();

const publicJwksSchema = z
  .object({ keys: z.array(publicSigningKeySchema).min(1).max(16) })
  .strict();

const BLOCKED_REQUEST_HEADERS = [
  'authorization',
  'cookie',
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'x-tenant-id',
  'x-org-unit-id',
  'x-dealer-org-unit-id',
  'x-financier-id',
  'x-customer-id',
  'content-encoding',
] as const;

export function isPublicJwksCacheEligible(request: Request, backendPath: string): boolean {
  if (request.method !== 'GET' || backendPath !== PUBLIC_JWKS_PATH || request.body !== null) {
    return false;
  }

  const url = new URL(request.url);
  if (url.search.length > 0) return false;
  if (BLOCKED_REQUEST_HEADERS.some((name) => request.headers.has(name))) return false;
  if (request.headers.has('content-length') && request.headers.get('content-length') !== '0') {
    return false;
  }

  const cacheControl = request.headers.get('cache-control')?.toLowerCase() ?? '';
  const pragma = request.headers.get('pragma')?.toLowerCase() ?? '';
  if (/\bno-cache\b|\bno-store\b|\bmax-age\s*=\s*0\b/u.test(cacheControl)) return false;
  if (/\bno-cache\b/u.test(pragma)) return false;
  return true;
}

function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = PUBLIC_JWKS_PATH;
  url.search = CACHE_KEY_QUERY;
  return new Request(url.toString(), { method: 'GET' });
}

async function boundedBody(response: Response): Promise<ArrayBuffer | null> {
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;

      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) {
        await reader.cancel('jwks_cache_invalid_chunk');
        return null;
      }

      length += chunk.byteLength;
      if (length > MAX_PUBLIC_JWKS_BYTES) {
        await reader.cancel('jwks_cache_size_limit');
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (length === 0) return null;
  const buffer = new ArrayBuffer(length);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

export function isValidPublicJwks(value: unknown): boolean {
  return publicJwksSchema.safeParse(value).success;
}

function parsePublicJwksBytes(bytes: ArrayBuffer): boolean {
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(new Uint8Array(bytes)),
    );
    return isValidPublicJwks(decoded);
  } catch {
    return false;
  }
}

export function isCacheablePublicJwksOriginResponse(response: Response): boolean {
  if (response.status !== 200 || response.headers.has('set-cookie')) return false;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/^application\/json(?:\s*;|\s*$)/u.test(contentType)) return false;

  const directives = (response.headers.get('cache-control') ?? '')
    .toLowerCase()
    .split(',')
    .map((directive) => directive.trim());
  if (!directives.includes('public')) return false;
  if (directives.some((directive) => /^(?:private|no-store|no-cache)(?:\s|=|$)/u.test(directive))) {
    return false;
  }

  const vary = response.headers.get('vary');
  if (vary !== null && !vary.split(',').every((field) => field.trim().toLowerCase() === 'origin')) {
    return false;
  }

  const contentLength = response.headers.get('content-length');
  return (
    contentLength === null ||
    (/^\d+$/u.test(contentLength) && Number(contentLength) <= MAX_PUBLIC_JWKS_BYTES)
  );
}

function clientResponse(bytes: ArrayBuffer, context: WorkerContext): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  return sanitizeBackendResponse(
    new Response(bytes, { status: 200, headers }),
    context.get('requestContext'),
  );
}

/** A cache lookup failure must fall back to the authenticated private origin. */
export async function readCachedPublicJwks(
  request: Request,
  backendPath: string,
  context: WorkerContext,
): Promise<Response | null> {
  if (!isPublicJwksCacheEligible(request, backendPath)) {
    context.set('cacheStatus', 'BYPASS');
    return null;
  }

  try {
    const cache = await caches.open(PUBLIC_JWKS_CACHE_NAME);
    const cached = await cache.match(cacheKey(request));
    if (cached === undefined || !isCacheablePublicJwksOriginResponse(cached)) {
      context.set('cacheStatus', 'MISS');
      return null;
    }
    const bytes = await boundedBody(cached);
    if (bytes === null || !parsePublicJwksBytes(bytes)) {
      context.set('cacheStatus', 'MISS');
      return null;
    }
    context.set('cacheStatus', 'HIT');
    return clientResponse(bytes, context);
  } catch {
    context.set('cacheStatus', 'ERROR');
    return null;
  }
}

async function writePublicJwksCache(request: Request, response: Response): Promise<void> {
  try {
    const bytes = await boundedBody(response);
    if (bytes === null || !parsePublicJwksBytes(bytes)) return;

    const cache = await caches.open(PUBLIC_JWKS_CACHE_NAME);
    await cache.put(
      cacheKey(request),
      new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${String(PUBLIC_JWKS_TTL_SECONDS)}`,
        },
      }),
    );
  } catch {
    // Best-effort cache storage must not alter the authoritative origin result.
  }
}

export function schedulePublicJwksCacheWrite(
  request: Request,
  backendPath: string,
  backendResponse: Response,
  context: WorkerContext,
): void {
  if (!isPublicJwksCacheEligible(request, backendPath)) return;
  if (!isCacheablePublicJwksOriginResponse(backendResponse)) return;

  try {
    context.executionCtx.waitUntil(writePublicJwksCache(request, backendResponse.clone()));
  } catch {
    // Local test environments may not provide an execution context or Cache API.
  }
}

/** Correlation headers are request-specific; never let a shared cache replay them. */
export function makePublicJwksResponseUncacheable(
  response: Response,
  backendPath: string,
): Response {
  if (backendPath !== PUBLIC_JWKS_PATH) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
