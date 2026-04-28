/**
 * Authentication middleware for the MCP endpoint.
 *
 * Accepts two token types on `Authorization: Bearer ...`:
 *   1. An OAuth 2.1 JWT issued by this server (primary path for Claude).
 *   2. The static MCP_API_KEY if configured (debug/curl fallback).
 *
 * Rejects with 401 + WWW-Authenticate header pointing at our resource
 * metadata, so OAuth clients can auto-discover the authorization server.
 */

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { loadOAuthConfig, verifyAccessToken, wwwAuthenticateHeader } from './oauth/index.js';

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** Constant-time string comparison. Returns false if lengths differ. */
function safeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractToken(req: Request): string | null {
  const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
  const xApiKey = (req.headers['x-api-key'] as string | undefined) ?? '';

  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  if (xApiKey) return xApiKey.trim();
  if (authHeader) return authHeader.trim();
  return null;
}

function send401(res: Response, message: string): void {
  try {
    res.setHeader('WWW-Authenticate', wwwAuthenticateHeader());
  } catch {
    // OAUTH_ISSUER_URL not configured — omit the header but still 401.
  }
  res.status(401).json(jsonRpcError(-32001, message));
}

export interface AuthenticatedRequest extends Request {
  auth?: {
    kind: 'jwt' | 'api_key';
    subject?: string;
    clientId?: string;
    scope?: string;
  };
}

export function buildMcpAuthMiddleware(options: {
  /** Static fallback key. Leave undefined to disable and require OAuth. */
  staticApiKey?: string;
}) {
  const staticKey = options.staticApiKey;

  return async function mcpAuthMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = extractToken(req);
    if (!token) {
      send401(res, 'Unauthorized: Missing credentials.');
      return;
    }

    // Try JWT first (OAuth path — primary for Claude)
    try {
      const { issuer, mcpResourceUrl } = loadOAuthConfig();
      const claims = await verifyAccessToken(token, { issuer, audience: mcpResourceUrl });
      req.auth = {
        kind: 'jwt',
        subject: claims.sub,
        clientId: claims.azp,
        scope: claims.scope,
      };
      next();
      return;
    } catch {
      // Not a valid JWT — fall through to static-key check.
    }

    // Fallback: static MCP_API_KEY (debug/curl)
    if (staticKey && safeStringEqual(token, staticKey)) {
      req.auth = { kind: 'api_key' };
      next();
      return;
    }

    send401(res, 'Unauthorized: Invalid or expired credentials.');
  };
}
