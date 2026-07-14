// oz-erp-edge/src/route-policy.ts
import type { WorkerConfig } from './config.js';

const WEBHOOK_ENDPOINT_KEY_PATTERN = '[A-Za-z0-9._:-]{8,160}';
const PUBLIC_TOKEN_PATTERN = '[A-Za-z0-9._~:-]{32,256}';

const TELECMI_WEBHOOK_PATTERN = new RegExp(
  `^/erp/channel-ingest/webhooks/telecmi/${WEBHOOK_ENDPOINT_KEY_PATTERN}$`,
  'u',
);
const MSG91_WEBHOOK_PATTERN = new RegExp(
  `^/erp/channel-ingest/webhooks/msg91/${WEBHOOK_ENDPOINT_KEY_PATTERN}$`,
  'u',
);
const ZEPTOMAIL_WEBHOOK_PATTERN = new RegExp(
  `^/erp/channel-ingest/webhooks/zeptomail/${WEBHOOK_ENDPOINT_KEY_PATTERN}$`,
  'u',
);
const WARRANTY_UPLOAD_PATTERN = new RegExp(
  `^/erp/engagement/public/forms/warranty/${PUBLIC_TOKEN_PATTERN}/files$`,
  'u',
);

export type BackendRouteClass = 'ERP_STANDARD' | 'RAW_WEBHOOK' | 'WARRANTY_MULTIPART';

function pathStartsWithPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function joinPath(prefix: string, pathname: string): string {
  if (prefix.length === 0) {
    return pathname;
  }

  if (pathname === '/') {
    return prefix;
  }

  return `${prefix.replace(/\/+$/u, '')}/${pathname.replace(/^\/+/, '')}`;
}

function stripPublicApiPrefix(pathname: string, publicApiPrefix: string): string | null {
  if (publicApiPrefix.length === 0) {
    return pathname;
  }

  if (pathname === publicApiPrefix) {
    return '/';
  }

  if (!pathname.startsWith(`${publicApiPrefix}/`)) {
    return null;
  }

  const stripped = pathname.slice(publicApiPrefix.length);
  return stripped.length === 0 ? '/' : stripped;
}

export function resolveBackendPath(pathname: string, config: WorkerConfig): string | null {
  const strippedPath = stripPublicApiPrefix(pathname, config.PUBLIC_API_PREFIX);

  if (strippedPath === null) {
    return null;
  }

  const backendPath = joinPath(config.BACKEND_PATH_PREFIX, strippedPath);

  if (config.BLOCKED_BACKEND_PREFIXES.some((prefix) => pathStartsWithPrefix(backendPath, prefix))) {
    return null;
  }

  if (
    !config.ALLOWED_BACKEND_PREFIXES.some((prefix) => pathStartsWithPrefix(backendPath, prefix))
  ) {
    return null;
  }

  return backendPath;
}

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

export function isOriginOptionalServerToServerRoute(method: string, backendPath: string): boolean {
  return classifyBackendRoute(method, backendPath) === 'RAW_WEBHOOK';
}
