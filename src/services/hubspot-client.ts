/**
 * HubSpot REST client with built-in rate limiting and retry logic.
 *
 * Hard guarantee: this client implements ONLY GET, POST, and PATCH methods.
 * DELETE is intentionally not exposed — callers cannot issue destructive
 * operations even if a tool tries to. This is enforced at the type level via
 * the `Method` union below, and at runtime via the request signature.
 *
 * HubSpot Private App rate limits (Pro): 100 req / 10s. We target 90 / 10s.
 * Reference: https://developers.hubspot.com/docs/guides/apps/api-usage/usage-details
 */

import {
  HUBSPOT_API_BASE,
  RATE_WINDOW_MS,
  MAX_REQUESTS_PER_WINDOW,
  MAX_RETRY_ATTEMPTS,
  PAGINATION_PAGE_DELAY_MS,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_SIZE,
} from '../constants.js';
import { logger } from '../logger.js';

/** Allowed HTTP methods. DELETE is deliberately omitted. */
type Method = 'GET' | 'POST' | 'PATCH';

interface HubSpotErrorBody {
  status?: string;
  message?: string;
  correlationId?: string;
  category?: string;
  errors?: Array<{ message: string; in?: string; code?: string }>;
}

/** Custom error type so callers can branch on HubSpot failures specifically. */
export class HubSpotApiError extends Error {
  readonly status?: number;
  readonly category?: string;
  readonly correlationId?: string;
  readonly details?: HubSpotErrorBody['errors'];

  constructor(
    message: string,
    opts: { status?: number; category?: string; correlationId?: string; details?: HubSpotErrorBody['errors'] } = {},
  ) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = opts.status;
    this.category = opts.category;
    this.correlationId = opts.correlationId;
    this.details = opts.details;
  }
}

/** Sliding-window rate limiter state — module-scoped so all callers share it. */
const requestTimestamps: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0]! <= now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = requestTimestamps[0]!;
    const waitUntil = oldest + RATE_WINDOW_MS + 10;
    const waitMs = waitUntil - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    while (requestTimestamps.length > 0 && requestTimestamps[0]! <= Date.now() - RATE_WINDOW_MS) {
      requestTimestamps.shift();
    }
  }

  requestTimestamps.push(Date.now());
}

interface RequestOptions {
  /** Path beneath HUBSPOT_API_BASE — must start with `/`. */
  path: string;
  method?: Method;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  attempt?: number;
  /** Optional custom fetch — useful for tests. */
  fetchImpl?: typeof fetch;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${HUBSPOT_API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Execute a request against HubSpot's REST API.
 * Retries on 429 with exponential backoff (uses Retry-After header when present).
 *
 * Throws {@link HubSpotApiError} for any failure mode.
 */
export async function hubspotRequest<TData = unknown>(options: RequestOptions): Promise<TData> {
  const { path, method = 'GET', query, body, attempt = 1, fetchImpl = fetch } = options;

  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) {
    throw new HubSpotApiError(
      'HubSpot credentials not configured. Set HUBSPOT_PRIVATE_APP_TOKEN.',
    );
  }

  await waitForRateLimit();

  const url = buildUrl(path, query);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    const msg = networkError instanceof Error ? networkError.message : String(networkError);
    throw new HubSpotApiError(`Network error connecting to HubSpot API: ${msg}`);
  }

  // Retry on 429 with exponential backoff, honoring Retry-After when present.
  if (response.status === 429) {
    if (attempt > MAX_RETRY_ATTEMPTS) {
      throw new HubSpotApiError(
        'HubSpot API rate limit exceeded after multiple retries. Please try again later.',
        { status: 429 },
      );
    }
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
    const backoffMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(1000 * 2 ** (attempt - 1), 30_000);
    logger.warn({ attempt, backoffMs, path }, 'HubSpot rate-limited; retrying');
    await sleep(backoffMs);
    return hubspotRequest<TData>({ ...options, attempt: attempt + 1 });
  }

  if (response.status === 204) {
    // No Content
    return undefined as TData;
  }

  const rawText = await response.text();
  let parsed: unknown;
  if (rawText.length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Leave parsed undefined; fall through to error path below.
    }
  }

  if (!response.ok) {
    const errBody = (parsed ?? {}) as HubSpotErrorBody;
    const fragments = [
      errBody.message,
      ...(errBody.errors?.map((e) => e.message) ?? []),
    ].filter(Boolean) as string[];
    const message = fragments.length > 0
      ? `HubSpot API HTTP ${response.status}: ${fragments.join('; ').slice(0, 400)}`
      : `HubSpot API HTTP ${response.status}: ${rawText.slice(0, 200)}`;
    throw new HubSpotApiError(message, {
      status: response.status,
      category: errBody.category,
      correlationId: errBody.correlationId,
      details: errBody.errors,
    });
  }

  return (parsed ?? {}) as TData;
}

/**
 * Paginate through all results of a list/search endpoint, fetching up to
 * `maxPages` pages.
 *
 * For GET list endpoints, pagination uses the `after` query parameter.
 * For POST search endpoints, pass `method: 'POST'` and a `body` — the cursor
 * will be merged into the body as `after` on each page.
 */
export async function paginate<TNode = unknown>(input: {
  path: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  pageSize?: number;
  maxPages?: number;
  /** Optional custom fetch — useful for tests. Forwarded to hubspotRequest. */
  fetchImpl?: typeof fetch;
}): Promise<TNode[]> {
  const {
    path,
    method = 'GET',
    query,
    body,
    pageSize = DEFAULT_PAGE_SIZE,
    maxPages = DEFAULT_MAX_PAGES,
    fetchImpl,
  } = input;

  const allNodes: TNode[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  while (pageCount < maxPages) {
    let response: { results?: TNode[]; paging?: { next?: { after?: string } } };

    if (method === 'GET') {
      response = await hubspotRequest({
        path,
        method: 'GET',
        query: { ...(query ?? {}), limit: pageSize, after: cursor },
        fetchImpl,
      });
    } else {
      response = await hubspotRequest({
        path,
        method: 'POST',
        body: { ...(body ?? {}), limit: pageSize, after: cursor },
        fetchImpl,
      });
    }

    allNodes.push(...(response.results ?? []));
    pageCount++;

    const next = response.paging?.next?.after;
    if (!next) break;
    cursor = next;

    if (pageCount < maxPages) await sleep(PAGINATION_PAGE_DELAY_MS);
  }

  return allNodes;
}

/** Reset internal rate-limiter state — exposed for tests only. */
export function _resetRateLimiterForTests(): void {
  requestTimestamps.length = 0;
}
