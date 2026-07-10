// oz-erp-edge/src/origin-policy.ts

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const WEBHOOK_ENDPOINT_KEY_PATTERN = '[A-Za-z0-9._:-]{8,160}';

const ORIGIN_OPTIONAL_SERVER_TO_SERVER_ROUTE_PATTERNS = [
  new RegExp(`^/erp/channel-ingest/webhooks/telecmi/${WEBHOOK_ENDPOINT_KEY_PATTERN}$`, 'u'),
  new RegExp(`^/erp/channel-ingest/webhooks/msg91/${WEBHOOK_ENDPOINT_KEY_PATTERN}$`, 'u'),
  new RegExp(`^/erp/channel-ingest/webhooks/zeptomail/${WEBHOOK_ENDPOINT_KEY_PATTERN}$`, 'u'),
] as const;

export type OriginRequirementInput = Readonly<{
  method: string;
  path: string;
  origin: string | null;
  requireOriginOnMutation: boolean;
}>;

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase();
}

function normalizePath(path: string): string {
  const normalized = path.trim();

  if (normalized.length === 0) {
    return '/';
  }

  return normalized;
}

export function isMutationMethod(method: string): boolean {
  return MUTATION_METHODS.has(normalizeMethod(method));
}

export function isOriginOptionalServerToServerRoute(method: string, path: string): boolean {
  if (normalizeMethod(method) !== 'POST') {
    return false;
  }

  const normalizedPath = normalizePath(path);

  return ORIGIN_OPTIONAL_SERVER_TO_SERVER_ROUTE_PATTERNS.some((pattern) =>
    pattern.test(normalizedPath),
  );
}

export function shouldRequireOrigin(input: OriginRequirementInput): boolean {
  if (!input.requireOriginOnMutation) {
    return false;
  }

  if (input.origin !== null) {
    return false;
  }

  if (!isMutationMethod(input.method)) {
    return false;
  }

  return !isOriginOptionalServerToServerRoute(input.method, input.path);
}
