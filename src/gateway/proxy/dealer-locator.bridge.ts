import { getWorkerConfig } from '../../config/index.js';
import type { WorkerEnv } from '../../config/index.js';
import type { EdgeProxyDependencies } from './edge-proxy.handler.js';
import { z } from 'zod';

export type BridgeEnv = WorkerEnv & { readonly DEALER_LOCATOR_BRIDGE_KEY?: string };
function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hex.match(/../gu)?.map((s) => Number.parseInt(s, 16)) ?? []);
}
function hex(data: ArrayBuffer): string {
  return [...new Uint8Array(data)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
/** Private named entrypoint. The ordinary public gateway never routes /internal. */
export async function fetchDealerLocatorBridge(
  request: Request,
  env: BridgeEnv,
  dependencies: EdgeProxyDependencies,
): Promise<Response> {
  const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' };
  const reject = (status: number) => new Response('{}', { status, headers });
  const url = new URL(request.url),
    timestamp = request.headers.get('x-locator-timestamp') ?? '',
    signature = request.headers.get('x-locator-signature') ?? '';
  if (
    request.method !== 'POST' ||
    url.search ||
    !/^\/internal\/dealer-locator\/(health|context|capture|submission)$/u.test(url.pathname) ||
    !env.DEALER_LOCATOR_BRIDGE_KEY ||
    !/^[a-f0-9]{64}$/u.test(env.DEALER_LOCATOR_BRIDGE_KEY)
  )
    return reject(404);
  if (
    !/^\d{10}$/u.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 ||
    !/^[a-f0-9]{64}$/u.test(signature)
  )
    return reject(403);
  const reader = request.body?.getReader();
  if (!reader) return reject(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk: unknown = part.value;
      if (!(chunk instanceof Uint8Array)) return reject(400);
      size += chunk.byteLength;
      if (size > 12_288) {
        await reader.cancel();
        return reject(413);
      }
      chunks.push(chunk);
    }
  } catch {
    return reject(400);
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(env.DEALER_LOCATOR_BRIDGE_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const digest = hex(await crypto.subtle.digest('SHA-256', body));
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      key,
      bytes(signature),
      new TextEncoder().encode(`POST\n${url.pathname}\n${timestamp}\n${digest}`),
    ))
  )
    return reject(403);
  try {
    const config = getWorkerConfig(env),
      token = await dependencies.tokenProvider(config);
    const response = await dependencies.fetcher(
      new Request(new URL(url.pathname, config.CLOUD_RUN_BASE_URL), {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Serverless-Authorization': `Bearer ${token}`,
          'X-Locator-Timestamp': timestamp,
          'X-Locator-Signature': signature,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
      }),
    );
    if (!response.ok) {
      if (
        response.status === 503 &&
        z
          .object({ code: z.literal('CAPTURE_PROCESSING') })
          .safeParse(await response.json().catch(() => null)).success
      )
        return Response.json({ code: 'CAPTURE_PROCESSING' }, { status: 503, headers });
      return reject(
        [400, 401, 403, 404, 409, 413, 422, 429].includes(response.status) ? response.status : 503,
      );
    }
    const result = await response.text();
    if (result.length > 4096) return reject(503);
    return new Response(result, { status: response.status, headers });
  } catch {
    return reject(503);
  }
}
