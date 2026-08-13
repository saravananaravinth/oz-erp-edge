// oz-erp-edge/src/gateway/routing/route-classifier.ts
import {
  POST_ONLY_RAW_WEBHOOK_PATTERNS,
  TELECMI_WEBHOOK_PATTERN,
  WARRANTY_UPLOAD_PATTERN,
} from './route-contract.js';

export type BackendRouteClass = 'ERP_STANDARD' | 'RAW_WEBHOOK' | 'WARRANTY_MULTIPART';

function matchesAnyPattern(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function classifyBackendRoute(method: string, backendPath: string): BackendRouteClass {
  const normalizedMethod = method.trim().toUpperCase();

  if (normalizedMethod === 'POST' && WARRANTY_UPLOAD_PATTERN.test(backendPath)) {
    return 'WARRANTY_MULTIPART';
  }

  if (
    TELECMI_WEBHOOK_PATTERN.test(backendPath) ||
    (normalizedMethod === 'POST' && matchesAnyPattern(POST_ONLY_RAW_WEBHOOK_PATTERNS, backendPath))
  ) {
    return 'RAW_WEBHOOK';
  }

  return 'ERP_STANDARD';
}
