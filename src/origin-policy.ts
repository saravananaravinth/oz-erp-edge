// oz-erp-edge/src/origin-policy.ts
import { isOriginOptionalRoute } from './route-policy.js';

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

export function shouldRequireOrigin(input: OriginRequirementInput): boolean {
  if (!input.requireOriginOnMutation || input.origin !== null || !isMutationMethod(input.method)) {
    return false;
  }

  if (input.backendPath === null) {
    return false;
  }

  return !isOriginOptionalRoute(input.method, input.backendPath);
}
