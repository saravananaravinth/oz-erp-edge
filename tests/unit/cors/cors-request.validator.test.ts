// oz-erp-edge/tests/unit/cors/cors-request.validator.test.ts
import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../../../src/config/index.js';
import { validateCorsPreflight } from '../../../src/gateway/cors/cors-request.validator.js';
import { createLocalWorkerEnv } from '../../fixtures/worker-env.js';

const config = parseWorkerConfig(createLocalWorkerEnv());

describe('CORS preflight validation', () => {
  it('accepts allowlisted methods and headers', () => {
    expect(
      validateCorsPreflight({
        requestedMethod: 'POST',
        requestedHeaders: 'authorization, content-type',
        config,
      }),
    ).toBeNull();
  });

  it('rejects unsupported methods and malformed headers', () => {
    expect(
      validateCorsPreflight({ requestedMethod: 'TRACE', requestedHeaders: null, config }),
    ).toMatchObject({ status: 405 });
    expect(
      validateCorsPreflight({ requestedMethod: 'POST', requestedHeaders: 'bad header', config }),
    ).toMatchObject({ status: 400 });
  });
});
