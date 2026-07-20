export type OutboundFetcher = typeof fetch;

export const outboundFetch: OutboundFetcher = async (input, init) =>
  await globalThis.fetch(input, init);
