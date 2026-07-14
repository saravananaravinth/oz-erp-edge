// oz-erp-edge/tests/security.test.ts
import { describe, expect, it } from 'vitest';

import { applySecurityHeaders } from '../src/security.js';

describe('applySecurityHeaders', () => {
  it('enforces strict API security headers and preserves backend cache policy', () => {
    const headers = new Headers({
      'cache-control': 'private, max-age=60',
      'referrer-policy': 'unsafe-url',
      'cross-origin-resource-policy': 'cross-origin',
    });

    applySecurityHeaders(headers);

    expect(headers.get('cache-control')).toBe('private, max-age=60');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
