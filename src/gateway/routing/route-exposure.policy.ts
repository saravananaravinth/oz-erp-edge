import type { WorkerConfig } from '../../config/index.js';

function pathStartsWithPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function joinPath(prefix: string, pathname: string): string {
  if (prefix.length === 0) return pathname;
  if (pathname === '/') return prefix;
  return `${prefix.replace(/\/+$/u, '')}/${pathname.replace(/^\/+/, '')}`;
}

function stripPublicApiPrefix(pathname: string, publicApiPrefix: string): string | null {
  if (publicApiPrefix.length === 0) return pathname;
  if (pathname === publicApiPrefix) return '/';
  if (!pathname.startsWith(`${publicApiPrefix}/`)) return null;

  const stripped = pathname.slice(publicApiPrefix.length);
  return stripped.length === 0 ? '/' : stripped;
}

export function resolveBackendPath(pathname: string, config: WorkerConfig): string | null {
  const strippedPath = stripPublicApiPrefix(pathname, config.PUBLIC_API_PREFIX);
  if (strippedPath === null) return null;

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
