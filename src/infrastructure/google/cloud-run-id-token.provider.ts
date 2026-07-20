// oz-erp-edge/src/infrastructure/google/cloud-run-id-token.provider.ts
import type { WorkerConfig } from '../../config/index.js';
import {
  base64UrlEncodeBytes,
  base64UrlEncodeText,
  decodeBase64Json,
} from '../../shared/encoding/base64url.js';
import { CloudRunTokenError } from '../../shared/auth/cloud-run-token.error.js';
import { outboundFetch, type OutboundFetcher } from '../../shared/http/outbound-fetch.js';
import { exchangeGoogleIdToken } from './google-token.client.js';
import {
  selectServiceAccountFields,
  serviceAccountKeySchema,
  type ServiceAccountKey,
} from './service-account-key.schema.js';
import { BoundedTokenCache } from './token-cache.js';

function parseServiceAccount(config: WorkerConfig): ServiceAccountKey {
  try {
    if (config.GCP_SERVICE_ACCOUNT_JSON_B64 === undefined) {
      throw new Error('Missing service-account credential.');
    }
    return serviceAccountKeySchema.parse(
      selectServiceAccountFields(decodeBase64Json(config.GCP_SERVICE_ACCOUNT_JSON_B64)),
    );
  } catch {
    throw new CloudRunTokenError('credential_invalid');
  }
}

function resolveTokenUri(config: WorkerConfig, serviceAccount: ServiceAccountKey): string {
  try {
    const tokenUri = serviceAccount.token_uri ?? config.GOOGLE_TOKEN_URI;
    if (config.APP_ENV === 'production' && new URL(tokenUri).protocol !== 'https:') {
      throw new Error('Insecure production token URI.');
    }
    return tokenUri;
  } catch {
    throw new CloudRunTokenError('credential_invalid');
  }
}

function pemToArrayBuffer(privateKeyPem: string): ArrayBuffer {
  const base64 = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/gu, '')
    .replace(/-----END PRIVATE KEY-----/gu, '')
    .replace(/\s+/gu, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function signRs256(input: string, privateKeyPem: string): Promise<string> {
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(privateKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(input),
    );
    return base64UrlEncodeBytes(new Uint8Array(signature));
  } catch {
    throw new CloudRunTokenError('signing_failed');
  }
}

async function createAssertion(input: {
  readonly serviceAccount: ServiceAccountKey;
  readonly targetAudience: string;
  readonly tokenUri: string;
}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const encodedHeader = base64UrlEncodeText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const encodedPayload = base64UrlEncodeText(
    JSON.stringify({
      iss: input.serviceAccount.client_email,
      sub: input.serviceAccount.client_email,
      aud: input.tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      target_audience: input.targetAudience,
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${await signRs256(signingInput, input.serviceAccount.private_key)}`;
}

export class CloudRunIdTokenProvider {
  readonly #fetcher: OutboundFetcher;
  readonly #cache: BoundedTokenCache;

  public constructor(
    input: Readonly<{ fetcher?: OutboundFetcher; cache?: BoundedTokenCache }> = {},
  ) {
    this.#fetcher = input.fetcher ?? outboundFetch;
    this.#cache = input.cache ?? new BoundedTokenCache(8);
  }

  public async getToken(config: WorkerConfig): Promise<string> {
    const serviceAccount = parseServiceAccount(config);
    const tokenUri = resolveTokenUri(config, serviceAccount);
    const cacheKey = `${serviceAccount.client_email}|${config.CLOUD_RUN_AUDIENCE}|${tokenUri}`;

    const cached = this.#cache.get(cacheKey);
    if (cached !== null) return cached;

    const assertion = await createAssertion({
      serviceAccount,
      targetAudience: config.CLOUD_RUN_AUDIENCE,
      tokenUri,
    });
    const exchanged = await exchangeGoogleIdToken({
      fetcher: this.#fetcher,
      tokenUri,
      assertion,
      timeoutMs: config.GOOGLE_TOKEN_TIMEOUT_MS,
    });
    const safeTtlSeconds = Math.max(
      60,
      exchanged.expiresInSeconds - config.GOOGLE_TOKEN_CACHE_SKEW_SECONDS,
    );
    this.#cache.set(cacheKey, {
      value: exchanged.value,
      expiresAtMs: Date.now() + safeTtlSeconds * 1000,
    });
    return exchanged.value;
  }
}

const defaultProvider = new CloudRunIdTokenProvider();

export async function getCloudRunIdToken(config: WorkerConfig): Promise<string> {
  return await defaultProvider.getToken(config);
}
