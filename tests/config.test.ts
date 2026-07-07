// oz-erp-edge/tests/config.test.ts
import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../src/config.js';

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

  it('accepts exact production frontend origins', () => {
    const config = parseWorkerConfig({
      APP_ENV: 'production',
      CLOUD_RUN_BASE_URL: 'https://oz-erp-api.example.run.app',
      CLOUD_RUN_AUDIENCE: 'https://oz-erp-api.example.run.app',
      ALLOWED_ORIGINS: 'https://erp.ozotecev.com',
      GCP_SERVICE_ACCOUNT_JSON_B64: fakeServiceAccountJson,
    });

    expect(config.ALLOWED_ORIGINS).toEqual(['https://erp.ozotecev.com']);
    expect(config.PUBLIC_API_PREFIX).toBe('');
  });
});
