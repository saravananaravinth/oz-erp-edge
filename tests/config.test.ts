// oz-erp-edge/tests/config.test.ts
import { describe, expect, it } from 'vitest';

import { parseWorkerConfig, resolveCloudRunAuthMode } from '../src/config.js';

const fakeServiceAccountJson = Buffer.from(
  JSON.stringify({
    client_email: 'oz-erp-edge-worker@example-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  }),
).toString('base64');

describe('parseWorkerConfig', () => {
  it('rejects wildcard production CORS origins when credentials are enabled', () => {
    expect(() =>
      parseWorkerConfig({
        APP_ENV: 'production',
        CLOUD_RUN_BASE_URL: 'https://oz-erp-api.example.run.app',
        CLOUD_RUN_AUDIENCE: 'https://oz-erp-api.example.run.app',
        ALLOWED_ORIGINS: '*',
        CORS_ALLOW_CREDENTIALS: 'true',
        GCP_SERVICE_ACCOUNT_JSON_B64: fakeServiceAccountJson,
      }),
    ).toThrow();
  });

  it('accepts exact production frontend origins with Cloud Run ID token auth', () => {
    const config = parseWorkerConfig({
      APP_ENV: 'production',
      CLOUD_RUN_BASE_URL: 'https://oz-erp-api.example.run.app',
      CLOUD_RUN_AUDIENCE: 'https://oz-erp-api.example.run.app',
      CLOUD_RUN_AUTH_MODE: 'id_token',
      ALLOWED_ORIGINS: 'https://erp.ozotecev.com',
      GCP_SERVICE_ACCOUNT_JSON_B64: fakeServiceAccountJson,
    });

    expect(config.ALLOWED_ORIGINS).toEqual(['https://erp.ozotecev.com']);
    expect(config.PUBLIC_API_PREFIX).toBe('');
    expect(resolveCloudRunAuthMode(config)).toBe('id_token');
  });

  it('accepts local backend without service account in development auto mode', () => {
    const config = parseWorkerConfig({
      APP_ENV: 'development',
      CLOUD_RUN_BASE_URL: 'http://localhost:8080',
      CLOUD_RUN_AUDIENCE: 'http://localhost:8080',
      CLOUD_RUN_AUTH_MODE: 'auto',
      ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
    });

    expect(resolveCloudRunAuthMode(config)).toBe('disabled');
    expect(config.GCP_SERVICE_ACCOUNT_JSON_B64).toBeUndefined();
  });

  it('rejects explicit disabled backend auth for non-local backends', () => {
    expect(() =>
      parseWorkerConfig({
        APP_ENV: 'development',
        CLOUD_RUN_BASE_URL: 'https://oz-erp-api.example.run.app',
        CLOUD_RUN_AUDIENCE: 'https://oz-erp-api.example.run.app',
        CLOUD_RUN_AUTH_MODE: 'disabled',
        ALLOWED_ORIGINS: 'http://localhost:3000',
      }),
    ).toThrow();
  });

  it('rejects disabled Cloud Run auth in production', () => {
    expect(() =>
      parseWorkerConfig({
        APP_ENV: 'production',
        CLOUD_RUN_BASE_URL: 'http://localhost:8080',
        CLOUD_RUN_AUDIENCE: 'http://localhost:8080',
        CLOUD_RUN_AUTH_MODE: 'disabled',
        ALLOWED_ORIGINS: 'https://erp.ozotecev.com',
      }),
    ).toThrow();
  });

  it('requires service account JSON when auto mode resolves to id_token', () => {
    expect(() =>
      parseWorkerConfig({
        APP_ENV: 'development',
        CLOUD_RUN_BASE_URL: 'https://oz-erp-api.example.run.app',
        CLOUD_RUN_AUDIENCE: 'https://oz-erp-api.example.run.app',
        CLOUD_RUN_AUTH_MODE: 'auto',
        ALLOWED_ORIGINS: 'http://localhost:3000',
      }),
    ).toThrow();
  });
});
