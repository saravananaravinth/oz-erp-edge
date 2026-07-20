# Route contracts

## Edge endpoints

- `GET /livez`
- `GET /readyz`

## Public proxy surface

Only configured `/erp/**` routes may reach Cloud Run. These prefixes are always blocked:

```text
/tasks
/metrics
/readyz
/healthz
/livez
/version
/erp/metrics
/erp/readyz
/erp/healthz
/erp/livez
/erp/version
```

## Route classes

- `ERP_STANDARD`: JSON, `application/*+json`, or URL-encoded requests; 1 MiB limit.
- `RAW_WEBHOOK`: exact TeleCMI, MSG91, and ZeptoMail webhook paths; provider media types allowed.
- `WARRANTY_MULTIPART`: exact warranty-file route; valid multipart boundary required; 11 MiB edge
  envelope.

## Origin-optional native operations

The route contract includes OTP request/verification, token refresh, session revocation, owner-guide
and happy-customer location updates, and assignment actions. Adding another exemption requires a
code change, tests, security review, and coordinated client documentation.
