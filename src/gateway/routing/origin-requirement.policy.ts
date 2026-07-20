// oz-erp-edge/src/gateway/routing/origin-requirement.policy.ts
import {
  AUTH_SESSION_REVOKE_PATTERN,
  HAPPY_CUSTOMER_ASSIGNMENT_ACTION_PATTERN,
  HAPPY_CUSTOMER_LOCATION_REQUEST_PATTERN,
  LEGACY_OWNER_GUIDE_ASSIGNMENT_ACTION_PATTERN,
  LEGACY_OWNER_GUIDE_LOCATION_REQUEST_PATTERN,
  NATIVE_APP_EXACT_MUTATION_ROUTES,
} from './route-contract.js';
import { classifyBackendRoute } from './route-classifier.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type OriginRequirementInput = Readonly<{
  method: string;
  backendPath: string | null;
  origin: string | null;
  requireOriginOnMutation: boolean;
}>;

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase();
}

export function isMutationMethod(method: string): boolean {
  return MUTATION_METHODS.has(normalizeMethod(method));
}

export function isOriginOptionalServerToServerRoute(method: string, backendPath: string): boolean {
  return classifyBackendRoute(method, backendPath) === 'RAW_WEBHOOK';
}

export function isOriginOptionalNativeAppRoute(method: string, backendPath: string): boolean {
  const normalizedMethod = normalizeMethod(method);
  if (NATIVE_APP_EXACT_MUTATION_ROUTES.has(`${normalizedMethod} ${backendPath}`)) return true;
  if (normalizedMethod === 'DELETE' && AUTH_SESSION_REVOKE_PATTERN.test(backendPath)) return true;
  if (normalizedMethod !== 'POST') return false;

  return (
    HAPPY_CUSTOMER_LOCATION_REQUEST_PATTERN.test(backendPath) ||
    HAPPY_CUSTOMER_ASSIGNMENT_ACTION_PATTERN.test(backendPath) ||
    LEGACY_OWNER_GUIDE_LOCATION_REQUEST_PATTERN.test(backendPath) ||
    LEGACY_OWNER_GUIDE_ASSIGNMENT_ACTION_PATTERN.test(backendPath)
  );
}

export function isOriginOptionalRoute(method: string, backendPath: string): boolean {
  return (
    isOriginOptionalServerToServerRoute(method, backendPath) ||
    isOriginOptionalNativeAppRoute(method, backendPath)
  );
}

export function shouldRequireOrigin(input: OriginRequirementInput): boolean {
  if (!input.requireOriginOnMutation || input.origin !== null || !isMutationMethod(input.method)) {
    return false;
  }
  if (input.backendPath === null) return false;
  return !isOriginOptionalRoute(input.method, input.backendPath);
}
