import { beforeAll, describe, expect, it, vi } from 'vitest';

import { parseWorkerConfig, type WorkerConfig } from '../../../src/config/index.js';
import { CloudRunIdTokenProvider } from '../../../src/infrastructure/google/cloud-run-id-token.provider.js';
import { CloudRunTokenError } from '../../../src/shared/auth/cloud-run-token.error.js';
import { createLocalWorkerEnv } from '../../fixtures/worker-env.js';

const idToken = `${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(40)}`;
let validConfig: WorkerConfig;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeJson(value: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJwtPart(value: string): Record<string, unknown> {
  const padded = value
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

function productionConfig(secret: string): WorkerConfig {
  return parseWorkerConfig(
    createLocalWorkerEnv({
      APP_ENV: 'production',
      ALLOWED_ORIGINS: 'https://erp.ozotecev.com',
      CLOUD_RUN_BASE_URL: 'https://service.run.app',
      CLOUD_RUN_AUDIENCE: 'https://service.run.app',
      CLOUD_RUN_AUTH_MODE: 'id_token',
      GCP_SERVICE_ACCOUNT_JSON_B64: secret,
    }),
  );
}

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const privateKeyBase64 = bytesToBase64(privateKey)
    .match(/.{1,64}/gu)
    ?.join('\n');
  if (privateKeyBase64 === undefined) throw new Error('Failed to encode the test private key.');
  validConfig = productionConfig(
    encodeJson({
      type: 'service_account',
      client_email: 'edge@example-project.iam.gserviceaccount.com',
      private_key: `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----\n`,
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  );
});

describe('Cloud Run ID token provider', () => {
  it('signs the expected assertion and reuses a cached token string', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a form-encoded body.');
      const form = new URLSearchParams(init.body);
      const assertion = form.get('assertion');
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      expect(assertion).not.toBeNull();
      const [header = '', payload = ''] = assertion?.split('.') ?? [];
      expect(decodeJwtPart(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
      expect(decodeJwtPart(payload)).toMatchObject({
        iss: 'edge@example-project.iam.gserviceaccount.com',
        sub: 'edge@example-project.iam.gserviceaccount.com',
        aud: 'https://oauth2.googleapis.com/token',
        target_audience: 'https://service.run.app',
      });
      return Response.json({ id_token: idToken, expires_in: 3600 });
    });
    const provider = new CloudRunIdTokenProvider({ fetcher });

    expect(await provider.getToken(validConfig)).toBe(idToken);
    expect(await provider.getToken(validConfig)).toBe(idToken);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('categorizes invalid credentials before making an outbound request', async () => {
    const fetcher = vi.fn();
    const provider = new CloudRunIdTokenProvider({ fetcher });

    await expect(provider.getToken(productionConfig('A'.repeat(128)))).rejects.toMatchObject({
      category: 'credential_invalid',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('categorizes private-key import and signing failures', async () => {
    const provider = new CloudRunIdTokenProvider({ fetcher: vi.fn() });
    const config = productionConfig(
      encodeJson({
        type: 'service_account',
        client_email: 'edge@example-project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----\n',
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );

    await expect(provider.getToken(config)).rejects.toBeInstanceOf(CloudRunTokenError);
    await expect(provider.getToken(config)).rejects.toMatchObject({ category: 'signing_failed' });
  });

  it('does not share an in-flight promise across simultaneous cold-cache requests', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 2) release();
      await barrier;
      return Response.json({ id_token: idToken, expires_in: 3600 });
    });
    const provider = new CloudRunIdTokenProvider({ fetcher });

    const tokens = await Promise.all([
      provider.getToken(validConfig),
      provider.getToken(validConfig),
    ]);

    expect(tokens).toEqual([idToken, idToken]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await provider.getToken(validConfig)).toBe(idToken);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
