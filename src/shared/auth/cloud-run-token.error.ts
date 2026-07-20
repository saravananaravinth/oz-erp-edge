export type CloudRunTokenFailureCategory =
  | 'credential_invalid'
  | 'signing_failed'
  | 'exchange_timeout'
  | 'exchange_network'
  | 'exchange_http'
  | 'exchange_invalid_response'
  | 'unknown';

export type CloudRunTokenFailure = Readonly<{
  category: CloudRunTokenFailureCategory;
  httpStatus: number | null;
}>;

export class CloudRunTokenError extends Error {
  public readonly category: CloudRunTokenFailureCategory;
  public readonly httpStatus: number | null;

  public constructor(
    category: Exclude<CloudRunTokenFailureCategory, 'unknown'>,
    httpStatus: number | null = null,
  ) {
    super('Cloud Run invocation token acquisition failed.');
    this.name = 'CloudRunTokenError';
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

export function classifyCloudRunTokenFailure(error: unknown): CloudRunTokenFailure {
  if (error instanceof CloudRunTokenError) {
    return { category: error.category, httpStatus: error.httpStatus };
  }
  return { category: 'unknown', httpStatus: null };
}
