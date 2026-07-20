// oz-erp-edge/src/shared/http/outbound-fetch.ts
export type OutboundFetcher = typeof fetch;

export const outboundFetch: OutboundFetcher = async (input, init) =>
  await globalThis.fetch(input, init);
