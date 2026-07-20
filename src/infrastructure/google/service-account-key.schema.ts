import { z } from 'zod';

export const serviceAccountKeySchema = z
  .object({
    client_email: z.string().trim().pipe(z.email()),
    private_key: z
      .string()
      .min(1)
      .max(16_384)
      .includes('-----BEGIN PRIVATE KEY-----')
      .includes('-----END PRIVATE KEY-----'),
    token_uri: z.string().trim().pipe(z.url()).optional(),
  })
  .strict();

export type ServiceAccountKey = z.output<typeof serviceAccountKeySchema>;

export function selectServiceAccountFields(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  return {
    client_email: record['client_email'],
    private_key: record['private_key'],
    token_uri: record['token_uri'],
  };
}
