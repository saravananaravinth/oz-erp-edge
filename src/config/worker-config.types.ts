export type CloudRunAuthMode = 'auto' | 'disabled' | 'id_token';
export type ResolvedCloudRunAuthMode = Exclude<CloudRunAuthMode, 'auto'>;

export type CloudflareVersionMetadata = Readonly<{
  id: string;
  tag: string;
  timestamp: string;
}>;

export type WorkerEnv = Readonly<{
  APP_ENV?: string;
  APP_NAME?: string;
  APP_VERSION?: string;
  PUBLIC_API_PREFIX?: string;
  BACKEND_PATH_PREFIX?: string;
  BACKEND_READINESS_PATH?: string;
  ALLOWED_BACKEND_PREFIXES?: string;
  BLOCKED_BACKEND_PREFIXES?: string;
  ALLOWED_ORIGINS?: string;
  ALLOWED_METHODS?: string;
  ALLOWED_HEADERS?: string;
  EXPOSED_HEADERS?: string;
  CORS_MAX_AGE_SECONDS?: string;
  CORS_ALLOW_CREDENTIALS?: string;
  REQUIRE_ORIGIN_ON_MUTATION?: string;
  MAX_BODY_BYTES?: string;
  FETCH_TIMEOUT_MS?: string;
  READINESS_TIMEOUT_MS?: string;
  CLOUD_RUN_BASE_URL?: string;
  CLOUD_RUN_AUDIENCE?: string;
  CLOUD_RUN_AUTH_MODE?: string;
  GOOGLE_TOKEN_URI?: string;
  GOOGLE_TOKEN_TIMEOUT_MS?: string;
  GOOGLE_TOKEN_CACHE_SKEW_SECONDS?: string;
  GCP_SERVICE_ACCOUNT_JSON_B64?: string;
  CF_VERSION_METADATA?: CloudflareVersionMetadata;
}>;

export type CloudRunAuthConfig = Readonly<{
  CLOUD_RUN_AUTH_MODE: CloudRunAuthMode;
  CLOUD_RUN_BASE_URL: string;
}>;
