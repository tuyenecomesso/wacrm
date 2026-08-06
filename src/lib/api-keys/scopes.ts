// ============================================================
// API key scopes — pure, unit-testable, no I/O.
//
// Authorization for the public API is *scopes-only*: a key's
// capabilities are defined entirely by the scopes granted to it at
// creation, independent of the role of the user who minted it. (We
// still gate *key creation* at admin+, so only trusted members can
// hand out capabilities — see the management routes.)
//
// A scope is `<resource>:<action>`. Endpoints declare the single
// scope they require; `requireApiKey(request, scope)` enforces it.
// Adding a capability = one entry here + the endpoint that checks
// it. No migration needed (the DB stores scopes as a free `text[]`).
// ============================================================

export const API_SCOPES = [
  // Public v1 contract — unchanged.
  'messages:send',
  'messages:read',
  'contacts:read',
  'contacts:write',
  'conversations:read',
  'broadcasts:send',
  'webhooks:manage',
  // Internal service-layer scopes (consumed by the business-hub over
  // bearer keys). `config:*` gate the WhatsApp config endpoints;
  // `admin` covers every account-management / automation / flows /
  // quick-replies / ai / business-insights route.
  'config:read',
  'config:write',
  'admin',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Human-readable descriptions, surfaced in the key-creation UI. */
export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  'messages:send': 'Send WhatsApp messages',
  'messages:read': 'Read messages and their delivery status',
  'contacts:read': 'List and read contacts',
  'contacts:write': 'Create and update contacts',
  'conversations:read': 'List and read conversations',
  'broadcasts:send': 'Launch broadcast campaigns',
  'webhooks:manage': 'Register and manage outbound event webhooks',
  'config:read': 'Read the WhatsApp integration config',
  'config:write': 'Change the WhatsApp integration config',
  'admin': 'Full account management (members, keys, automations, flows)',
};

/** Type-narrow an unknown value into a valid `ApiScope`. */
export function isApiScope(value: unknown): value is ApiScope {
  return (
    typeof value === 'string' &&
    (API_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Validate and de-duplicate a caller-supplied scope list. Returns
 * the cleaned list, or `null` if any entry is not a known scope
 * (callers turn that into a 400). An empty input is valid — it
 * yields a key that authenticates but can't do anything beyond the
 * scope-free endpoints (e.g. `GET /api/v1/me`).
 */
export function normalizeScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input)) return null;
  const out: ApiScope[] = [];
  for (const entry of input) {
    if (!isApiScope(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * True iff `granted` contains `required`. The single source of
 * truth for "is this key allowed to do X?" — both `requireApiKey`
 * and any future inline check should call this rather than poking
 * at the array directly.
 */
export function hasScope(
  granted: readonly string[],
  required: ApiScope
): boolean {
  return granted.includes(required);
}

// ============================================================
// Route → scope map.
//
// The middleware (`src/middleware.ts`) and the public API routes
// both consult this table: given a method + path it answers "which
// scope does this route require?" A `null` answer means *authentication
// only* — any valid key passes (e.g. `GET /api/v1/me`). A first-party
// `whsec_…` key bypasses scope checks entirely (see `satisfiesScope`).
//
// Rules are longest-prefix-first: a more specific prefix (e.g.
// `/api/whatsapp/config/verify-registration`) must win over its
// parent (`/api/whatsapp/config`). Keep them ordered that way.
// ============================================================

export interface RouteScopeRule {
  prefix: string;
  get?: ApiScope;
  post?: ApiScope;
  put?: ApiScope;
  patch?: ApiScope;
  delete?: ApiScope;
}

const ROUTE_SCOPE_RULES: readonly RouteScopeRule[] = [
  // --- WhatsApp config + registration (first-party / BH) ---
  { prefix: '/api/whatsapp/config/verify-registration', get: 'config:write', post: 'config:write' },
  { prefix: '/api/whatsapp/config', get: 'config:read', post: 'config:write', put: 'config:write', delete: 'config:write' },
  // --- Message pipeline ---
  { prefix: '/api/whatsapp/send', post: 'messages:send' },
  { prefix: '/api/whatsapp/react', post: 'messages:send' },
  { prefix: '/api/whatsapp/broadcast', post: 'broadcasts:send' },
  { prefix: '/api/whatsapp/templates', post: 'messages:send', get: 'messages:read', put: 'messages:send', patch: 'messages:send', delete: 'messages:send' },
  { prefix: '/api/whatsapp/media/upload', post: 'messages:send' },
  { prefix: '/api/whatsapp/media', get: 'messages:read' },
  // --- Public v1 API ---
  { prefix: '/api/v1/contacts', get: 'contacts:read', post: 'contacts:write', patch: 'contacts:write' },
  { prefix: '/api/v1/conversations', get: 'conversations:read' },
  { prefix: '/api/v1/messages', get: 'messages:read', post: 'messages:send' },
  { prefix: '/api/v1/broadcasts', get: 'broadcasts:send', post: 'broadcasts:send' },
  { prefix: '/api/v1/webhooks', get: 'webhooks:manage', post: 'webhooks:manage', delete: 'webhooks:manage' },
  { prefix: '/api/v1/me', get: undefined },
  // --- Account + automation management (admin) ---
  { prefix: '/api/account', get: 'admin', post: 'admin', put: 'admin', patch: 'admin', delete: 'admin' },
  { prefix: '/api/automations', get: 'admin', post: 'admin', put: 'admin', delete: 'admin' },
  { prefix: '/api/flows', get: 'admin', post: 'admin', put: 'admin', delete: 'admin' },
  { prefix: '/api/quick-replies', get: 'admin', post: 'admin', put: 'admin', delete: 'admin' },
  { prefix: '/api/ai', get: 'admin', post: 'admin', put: 'admin', delete: 'admin' },
  { prefix: '/api/business-insights', get: 'admin' },
];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Longest-prefix match for `pathname`. Returns the rule whose prefix
 * is a prefix of the path and is the longest among all matches — so
 * `/api/whatsapp/config/verify-registration` beats `/api/whatsapp/config`.
 */
function matchRouteRule(pathname: string): RouteScopeRule | null {
  let best: RouteScopeRule | null = null;
  for (const rule of ROUTE_SCOPE_RULES) {
    if (pathname === rule.prefix || pathname.startsWith(rule.prefix)) {
      if (!best || rule.prefix.length > best.prefix.length) best = rule;
    }
  }
  return best;
}

/**
 * The single scope a `method` request to `pathname` requires, or
 * `null` if authentication alone suffices. The middleware and the
 * `requireScope` helper both use this as the source of truth.
 */
export function requiredScopeFor(
  method: string,
  pathname: string
): ApiScope | null {
  const rule = matchRouteRule(pathname);
  if (!rule) return null;
  const scope = rule[method.toLowerCase() as HttpMethod];
  return scope ?? null;
}

/**
 * Scope authorization for a resolved key. `granted === null` means a
 * first-party `whsec_…` key — a trusted business-hub actor, so it
 * bypasses scope checks. Otherwise it's the key's `scopes[]`.
 */
export function satisfiesScope(
  granted: readonly string[] | null,
  required: ApiScope
): boolean {
  if (granted === null) return true;
  return hasScope(granted, required);
}
