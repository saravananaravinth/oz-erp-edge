// oz-erp-edge/src/gcp-id-token.ts
import { z } from 'zod';

import type { WorkerConfig } from './config.js';

const serviceAccountKeySchema = z
  .object({
    client_email: z.string().trim().pipe(z.email()),
    private_key: z
      .string()
      .min(1)
      .max(16_384)
      .includes('-----BEGIN PRIVATE KEY-----')
      .includes('-----END PRIVATE KEY-----'),
    token_uri: z.string().trim().pipe(z.url()).optional(),
  })
  .strict();

const googleTokenResponseSchema = z
  .object({
    id_token: z.string().min(100).max(8192),
    token_type: z.string().min(1).max(128).optional(),
    expires_in: z.union([z.number().int().positive(), z.string().regex(/^\d+$/u)]).optional(),
  })
  .strict();

type ServiceAccountKey = z.output<typeof serviceAccountKeySchema>;
type CachedIdToken = Readonly<{
  value: string;
  expiresAtMs: number;
  audience: string;
  clientEmail: string;
}>;

let cachedIdToken: CachedIdToken | null = null;
let inFlightIdTokenPromise: Promise<CachedIdToken> | null = null;

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function base64UrlEncodeText(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function decodeBase64Json(value: string): unknown {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function selectServiceAccountFields(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Readonly<Record<string, unknown>>;

  return {
    client_email: record['client_email'],
    private_key: record['private_key'],
    token_uri: record['token_uri'],
  };
}

function parseServiceAccountKey(config: WorkerConfig): ServiceAccountKey {
  return serviceAccountKeySchema.parse(
    selectServiceAccountFields(decodeBase64Json(config.GCP_SERVICE_ACCOUNT_JSON_B64)),
  );
}

function pemToArrayBuffer(privateKeyPem: string): ArrayBuffer {
  const base64 = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/gu, '')
    .replace(/-----END PRIVATE KEY-----/gu, '')
    .replace(/\s+/gu, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );
}

async function signRs256(input: string, privateKeyPem: string): Promise<string> {
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(input),
  );

  return base64UrlEncodeBytes(new Uint8Array(signature));
}

async function createSignedJwt(input: {
  readonly serviceAccount: ServiceAccountKey;
  readonly audience: string;
  readonly tokenUri: string;
}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  } as const;
  const payload = {
    iss: input.serviceAccount.client_email,
    sub: input.serviceAccount.client_email,
    aud: input.tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3_600,
    target_audience: input.audience,
  } as const;
  const encodedHeader = base64UrlEncodeText(JSON.stringify(header));
  const encodedPayload = base64UrlEncodeText(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signRs256(signingInput, input.serviceAccount.private_key);

  return `${signingInput}.${signature}`;
}

function resolveExpiresInSeconds(value: z.output<typeof googleTokenResponseSchema>['expires_in']): number {
  if (value === undefined) {
    return 3_600;
  }

  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

async function fetchGoogleSignedIdToken(config: WorkerConfig): Promise<CachedIdToken> {
  const serviceAccount = parseServiceAccountKey(config);
  const tokenUri = serviceAccount.token_uri ?? config.GOOGLE_TOKEN_URI;
  const assertion = await createSignedJwt({
    serviceAccount,
    audience: config.CLOUD_RUN_AUDIENCE,
    tokenUri,
  });
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });

  if (!response.ok) {
    throw new Error('Google ID token exchange failed.');
  }

  const body: unknown = await response.json();
  const parsed = googleTokenResponseSchema.parse(body);
  const expiresInSeconds = resolveExpiresInSeconds(parsed.expires_in);
  const safeTtlSeconds = Math.max(60, expiresInSeconds - config.GOOGLE_TOKEN_CACHE_SKEW_SECONDS);

  return {
    value: parsed.id_token,
    expiresAtMs: Date.now() + safeTtlSeconds * 1_000,
    audience: config.CLOUD_RUN_AUDIENCE,
    clientEmail: serviceAccount.client_email,
  };
}

export async function getCloudRunIdToken(config: WorkerConfig): Promise<string> {
  const cached = cachedIdToken;

  if (
    cached !== null &&
    cached.audience === config.CLOUD_RUN_AUDIENCE &&
    cached.expiresAtMs > Date.now() + 30_000
  ) {
    return cached.value;
  }

  if (inFlightIdTokenPromise !== null) {
    const token = await inFlightIdTokenPromise;
    return token.value;
  }

  inFlightIdTokenPromise = fetchGoogleSignedIdToken(config);

  try {
    const token = await inFlightIdTokenPromise;
    cachedIdToken = token;
    return token.value;
  } finally {
    inFlightIdTokenPromise = null;
  }
}
