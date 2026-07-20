# Security boundaries

## Origin enforcement

An absent browser `Origin` is allowed only for exact provider webhook contracts and exact native-app
mutation contracts defined in `route-contract.ts`. A bearer token alone is not an origin bypass.
This prevents arbitrary authenticated browser mutations from evading origin policy.

## Header trust boundary

The gateway removes:

- client-supplied Cloud Run authorization;
- Cloud Tasks and Google identity headers;
- Cloudflare and proxy identity headers;
- cookies;
- hop-by-hop headers;
- untrusted forwarded headers.

The gateway then creates trusted request and correlation IDs, edge identity, forwarded protocol, and
client IP. Tenant and actor selector headers may be forwarded but remain untrusted selectors; the
backend must authorize them against `ActorContext`.

## Credential handling

`GCP_SERVICE_ACCOUNT_JSON_B64` is a Worker secret. The decoded service-account document is validated
and reduced to the email, PKCS#8 private key, and optional token URI. It is never logged or included
in problem responses.

The Google ID-token cache is bounded to eight keys, removes expired entries, applies TTL skew, and
stores only token strings and expiry timestamps. Request-bound promises and I/O objects are never
shared across Worker invocations. Token exchange and backend requests use bounded timeouts.

Token failures are logged by safe category and optional upstream HTTP status. Assertions, tokens,
private keys, service-account documents, and upstream response bodies are never logged.

## Request bodies

Compressed requests are rejected. Standard requests are limited to 1 MiB. The exact warranty upload
route receives an 11 MiB edge envelope; the backend retains the authoritative file-size and
file-type limits. Unknown-length streams are read incrementally and cancelled once they exceed the
limit.
