/**
 * In-memory stores for OAuth state:
 *  - Registered clients (from Dynamic Client Registration)
 *  - Issued authorization codes (short-lived, single-use)
 *  - Active refresh tokens (long-lived, rotating)
 *
 * A Railway redeploy will wipe all of this and force users to re-authorize.
 * For single-user personal use this is acceptable. Swap for Postgres when needed.
 */

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

// ---------------------------------------------------------------------------
// Users — loaded from OAUTH_USERS env (JSON array)
// ---------------------------------------------------------------------------

export interface OAuthUser {
  email: string;
  password_hash: string;
}

let cachedUsers: OAuthUser[] | null = null;

export function loadUsers(): OAuthUser[] {
  if (cachedUsers) return cachedUsers;
  const raw = process.env.OAUTH_USERS;
  if (!raw) {
    cachedUsers = [];
    return cachedUsers;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('OAUTH_USERS must be a JSON array');
    const users = parsed.map((u, i) => {
      if (!u || typeof u !== 'object') throw new Error(`OAUTH_USERS[${i}] invalid`);
      if (typeof u.email !== 'string' || typeof u.password_hash !== 'string') {
        throw new Error(`OAUTH_USERS[${i}] needs email + password_hash`);
      }
      return { email: u.email.toLowerCase(), password_hash: u.password_hash } satisfies OAuthUser;
    });
    cachedUsers = users;
    return users;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse OAUTH_USERS: ${msg}`);
  }
}

/** Verify email+password, return the matched user on success. */
export async function verifyUserCredentials(
  email: string,
  password: string,
): Promise<OAuthUser | null> {
  const users = loadUsers();
  const candidate = users.find((u) => u.email === email.toLowerCase());
  if (!candidate) {
    // Hash a dummy to keep login timing similar to the match path.
    await bcrypt.compare(password, '$2b$12$................................................');
    return null;
  }
  const ok = await bcrypt.compare(password, candidate.password_hash);
  return ok ? candidate : null;
}

/** Reset cached users — for tests. */
export function _resetUserCacheForTests(): void {
  cachedUsers = null;
}

// ---------------------------------------------------------------------------
// Registered clients (DCR)
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  client_id: string;
  client_secret?: string; // optional — public clients use PKCE only
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post';
  grant_types: string[];
  response_types: string[];
  created_at: number;
}

const clients = new Map<string, RegisteredClient>();

export function registerClient(partial: Omit<RegisteredClient, 'client_id' | 'created_at'>): RegisteredClient {
  const client: RegisteredClient = {
    client_id: `mcp_${randomBytes(16).toString('base64url')}`,
    created_at: Date.now(),
    ...partial,
  };
  clients.set(client.client_id, client);
  return client;
}

export function getClient(clientId: string): RegisteredClient | undefined {
  return clients.get(clientId);
}

// ---------------------------------------------------------------------------
// Authorization codes — short-lived, single-use, bound to PKCE challenge
// ---------------------------------------------------------------------------

export interface AuthCodeRecord {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  user_email: string;
  scope: string;
  expires_at: number;
}

const authCodes = new Map<string, AuthCodeRecord>();

const AUTH_CODE_TTL_MS = 60_000; // 1 minute

export function issueAuthCode(
  record: Omit<AuthCodeRecord, 'code' | 'expires_at'>,
): AuthCodeRecord {
  const code = `code_${randomBytes(24).toString('base64url')}`;
  const entry: AuthCodeRecord = {
    ...record,
    code,
    expires_at: Date.now() + AUTH_CODE_TTL_MS,
  };
  authCodes.set(code, entry);
  return entry;
}

/** Consume an auth code (single-use). Returns it if still valid, else null. */
export function consumeAuthCode(code: string): AuthCodeRecord | null {
  const entry = authCodes.get(code);
  if (!entry) return null;
  authCodes.delete(code); // single-use regardless of expiry
  if (Date.now() > entry.expires_at) return null;
  return entry;
}

// ---------------------------------------------------------------------------
// Refresh tokens — long-lived, rotating
// ---------------------------------------------------------------------------

export interface RefreshTokenRecord {
  token: string;
  client_id: string;
  user_email: string;
  scope: string;
  expires_at: number;
}

const refreshTokens = new Map<string, RefreshTokenRecord>();

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

export function issueRefreshToken(
  record: Omit<RefreshTokenRecord, 'token' | 'expires_at'>,
): RefreshTokenRecord {
  const token = `rt_${randomBytes(32).toString('base64url')}`;
  const entry: RefreshTokenRecord = {
    ...record,
    token,
    expires_at: Date.now() + REFRESH_TOKEN_TTL_MS,
  };
  refreshTokens.set(token, entry);
  return entry;
}

/** Rotate a refresh token — consume old, return new record or null if invalid. */
export function rotateRefreshToken(
  oldToken: string,
): { old: RefreshTokenRecord; fresh: RefreshTokenRecord } | null {
  const existing = refreshTokens.get(oldToken);
  if (!existing) return null;
  refreshTokens.delete(oldToken);
  if (Date.now() > existing.expires_at) return null;
  const fresh = issueRefreshToken({
    client_id: existing.client_id,
    user_email: existing.user_email,
    scope: existing.scope,
  });
  return { old: existing, fresh };
}

/** Reset all in-memory OAuth state — for tests. */
export function _resetOAuthStoreForTests(): void {
  clients.clear();
  authCodes.clear();
  refreshTokens.clear();
}
