/**
 * Shared constants for the HubSpot MCP server.
 */

export const HUBSPOT_API_BASE = 'https://api.hubapi.com';

/** Maximum response size in characters before truncation. */
export const CHARACTER_LIMIT = 25_000;

/**
 * Rate limiting. HubSpot Private Apps allow 100 req / 10s on Pro and 150 / 10s
 * on Enterprise. We target 90 / 10s to leave headroom for incidental traffic
 * and to stay safe across plans.
 *
 * Reference: https://developers.hubspot.com/docs/guides/apps/api-usage/usage-details
 */
export const RATE_WINDOW_MS = 10_000;
export const MAX_REQUESTS_PER_WINDOW = 90;

/** Maximum retry attempts on 429 before giving up. */
export const MAX_RETRY_ATTEMPTS = 4;

/** Delay between paginated query pages (ms). */
export const PAGINATION_PAGE_DELAY_MS = 250;

/** Default safety limit on paginated query pages. */
export const DEFAULT_MAX_PAGES = 50;

/** Default page size for HubSpot list/search endpoints (max is 100). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
