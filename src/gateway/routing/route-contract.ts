export const WEBHOOK_ENDPOINT_KEY_PATTERN = '[A-Za-z0-9._:-]{8,160}';
export const PUBLIC_TOKEN_PATTERN = '[A-Za-z0-9._~:-]{32,256}';
export const UUID_PATTERN =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';

export const TELECMI_WEBHOOK_PATTERN = new RegExp(
  `^/erp/channel-ingest/webhooks/telecmi/${WEBHOOK_ENDPOINT_KEY_PATTERN}$`,
  'u',
);
export const MSG91_WEBHOOK_PATTERN = new RegExp(
  `^/erp/channel-ingest/webhooks/msg91/${WEBHOOK_ENDPOINT_KEY_PATTERN}$`,
  'u',
);
export const ZEPTOMAIL_WEBHOOK_PATTERN = new RegExp(
  `^/erp/channel-ingest/webhooks/zeptomail/${WEBHOOK_ENDPOINT_KEY_PATTERN}$`,
  'u',
);
export const WARRANTY_UPLOAD_PATTERN = new RegExp(
  `^/erp/engagement/public/forms/warranty/${PUBLIC_TOKEN_PATTERN}/files$`,
  'u',
);
export const HAPPY_CUSTOMER_LOCATION_REQUEST_PATTERN = new RegExp(
  `^/erp/engagement/happy-customer/location-requests/${UUID_PATTERN}/location$`,
  'u',
);
export const HAPPY_CUSTOMER_ASSIGNMENT_ACTION_PATTERN = new RegExp(
  `^/erp/engagement/happy-customer/assignments/${UUID_PATTERN}/(?:accept|reject|visit|test-drive-complete)$`,
  'u',
);
export const LEGACY_OWNER_GUIDE_LOCATION_REQUEST_PATTERN = new RegExp(
  `^/erp/engagement/owner-guide/location-requests/${UUID_PATTERN}/location$`,
  'u',
);
export const LEGACY_OWNER_GUIDE_ASSIGNMENT_ACTION_PATTERN = new RegExp(
  `^/erp/engagement/owner-guide/assignments/${UUID_PATTERN}/(?:accept|reject|visit|test-drive-complete)$`,
  'u',
);
export const AUTH_SESSION_REVOKE_PATTERN = new RegExp(
  `^/erp/auth/sessions/(?:current|${UUID_PATTERN})$`,
  'u',
);

export const NATIVE_APP_EXACT_MUTATION_ROUTES = new Set([
  'POST /erp/auth/login/otp/request',
  'POST /erp/auth/login/otp/verify',
  'POST /erp/auth/token/refresh',
  'PUT /erp/engagement/happy-customer/me/location',
  'PUT /erp/engagement/owner-guide/me/location',
]);
