import { describe, expect, it } from 'vitest';

import { classifyBackendRoute } from '../../../src/gateway/routing/route-classifier.js';

describe('route classification', () => {
  it('classifies exact provider webhooks', () => {
    expect(
      classifyBackendRoute('POST', '/erp/channel-ingest/webhooks/zeptomail/endpoint-key-1234'),
    ).toBe('RAW_WEBHOOK');
  });

  it('classifies only the exact warranty multipart route', () => {
    const token = 'a'.repeat(32);
    expect(
      classifyBackendRoute('POST', `/erp/engagement/public/forms/warranty/${token}/files`),
    ).toBe('WARRANTY_MULTIPART');
    expect(classifyBackendRoute('POST', `/erp/engagement/public/forms/warranty/${token}`)).toBe(
      'ERP_STANDARD',
    );
  });
});
