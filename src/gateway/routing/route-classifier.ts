// oz-erp-edge/src/gateway/routing/route-classifier.ts
import {
  MSG91_WEBHOOK_PATTERN,
  TELECMI_WEBHOOK_PATTERN,
  WARRANTY_UPLOAD_PATTERN,
  ZEPTOMAIL_WEBHOOK_PATTERN,
} from './route-contract.js';

export type BackendRouteClass = 'ERP_STANDARD' | 'RAW_WEBHOOK' | 'WARRANTY_MULTIPART';

export function classifyBackendRoute(method: string, backendPath: string): BackendRouteClass {
  const normalizedMethod = method.trim().toUpperCase();

  if (normalizedMethod === 'POST' && WARRANTY_UPLOAD_PATTERN.test(backendPath)) {
    return 'WARRANTY_MULTIPART';
  }

  if (
    TELECMI_WEBHOOK_PATTERN.test(backendPath) ||
    (normalizedMethod === 'POST' &&
      (MSG91_WEBHOOK_PATTERN.test(backendPath) || ZEPTOMAIL_WEBHOOK_PATTERN.test(backendPath)))
  ) {
    return 'RAW_WEBHOOK';
  }

  return 'ERP_STANDARD';
}
