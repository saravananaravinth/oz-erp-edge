// oz-erp-edge/tests/unit/routing/route-policy.test.ts
import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../../../src/config/index.js';
import { shouldRequireOrigin } from '../../../src/gateway/routing/origin-requirement.policy.js';
import { resolveBackendPath } from '../../../src/gateway/routing/route-exposure.policy.js';
import { createLocalWorkerEnv } from '../../fixtures/worker-env.js';

const config = parseWorkerConfig(createLocalWorkerEnv());

describe('route exposure', () => {
  it('allows approved ERP paths and blocks operational paths', () => {
    expect(resolveBackendPath('/erp/auth/login', config)).toBe('/erp/auth/login');
    expect(resolveBackendPath('/erp/readyz', config)).toBeNull();
    expect(resolveBackendPath('/tasks/notification', config)).toBeNull();
    expect(resolveBackendPath('/unknown', config)).toBeNull();
  });
});

describe('origin requirement', () => {
  it('requires origin for ordinary mutations even when a bearer token may be present upstream', () => {
    expect(
      shouldRequireOrigin({
        method: 'POST',
        backendPath: '/erp/inventory/vehicles/export',
        origin: null,
        requireOriginOnMutation: true,
      }),
    ).toBe(true);
  });

  it('allows exact native-app and webhook mutations without origin', () => {
    expect(
      shouldRequireOrigin({
        method: 'POST',
        backendPath: '/erp/auth/login/otp/request',
        origin: null,
        requireOriginOnMutation: true,
      }),
    ).toBe(false);
    expect(
      shouldRequireOrigin({
        method: 'POST',
        backendPath: '/erp/channel-ingest/webhooks/msg91/endpoint-key-1234',
        origin: null,
        requireOriginOnMutation: true,
      }),
    ).toBe(false);
  });
});
