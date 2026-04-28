/**
 * /token endpoint — supports `authorization_code` (with PKCE) and `refresh_token`
 * grant types.
 *
 * Access tokens are issued as HS256 JWTs; refresh tokens are opaque
 * random strings tracked in-memory.
 */

import type { Router, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  consumeAuthCode,
  getClient,
  issueRefreshToken,
  rotateRefreshToken,
} from './store.js';
import { signAccessToken } from './jwt.js';
import { loadOAuthConfig } from './config.js';

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function verifyPkce(verifier: string, challenge: string): boolean {
  const hashed = createHash('sha256').update(verifier).digest('base64url');
  // constant-time compare
  if (hashed.length !== challenge.length) return false;
  let mismatch = 0;
  for (let i = 0; i < hashed.length; i++) {
    mismatch |= hashed.charCodeAt(i) ^ challenge.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const AuthCodeGrantSchema = z
  .object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    redirect_uri: z.string().min(1),
    client_id: z.string().min(1),
    code_verifier: z.string().min(43).max(128),
    client_secret: z.string().optional(),
  })
  .passthrough();

const RefreshGrantSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
  scope: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function registerTokenRoute(router: Router): void {
  router.post('/token', async (req: Request, res: Response) => {
    const grantType = req.body?.grant_type;
    try {
      if (grantType === 'authorization_code') {
        await handleAuthCodeGrant(req, res);
      } else if (grantType === 'refresh_token') {
        await handleRefreshGrant(req, res);
      } else {
        sendTokenError(res, 400, 'unsupported_grant_type', 'Unsupported grant_type.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendTokenError(res, 500, 'server_error', msg);
    }
  });
}

async function handleAuthCodeGrant(req: Request, res: Response): Promise<void> {
  const parsed = AuthCodeGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    sendTokenError(
      res,
      400,
      'invalid_request',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
    return;
  }
  const input = parsed.data;

  const record = consumeAuthCode(input.code);
  if (!record) {
    sendTokenError(res, 400, 'invalid_grant', 'Auth code invalid, already used, or expired.');
    return;
  }
  if (record.client_id !== input.client_id) {
    sendTokenError(res, 400, 'invalid_grant', 'client_id mismatch for auth code.');
    return;
  }
  if (record.redirect_uri !== input.redirect_uri) {
    sendTokenError(res, 400, 'invalid_grant', 'redirect_uri mismatch for auth code.');
    return;
  }
  if (!getClient(input.client_id)) {
    sendTokenError(res, 400, 'invalid_client', 'Unknown client_id.');
    return;
  }
  if (!verifyPkce(input.code_verifier, record.code_challenge)) {
    sendTokenError(res, 400, 'invalid_grant', 'PKCE code_verifier does not match.');
    return;
  }

  await issueTokens(res, {
    clientId: input.client_id,
    userEmail: record.user_email,
    scope: record.scope,
  });
}

async function handleRefreshGrant(req: Request, res: Response): Promise<void> {
  const parsed = RefreshGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    sendTokenError(
      res,
      400,
      'invalid_request',
      parsed.error.issues.map((i) => i.message).join('; '),
    );
    return;
  }

  const rotated = rotateRefreshToken(parsed.data.refresh_token);
  if (!rotated) {
    sendTokenError(res, 400, 'invalid_grant', 'Refresh token invalid or expired.');
    return;
  }

  if (rotated.fresh.client_id !== parsed.data.client_id) {
    sendTokenError(res, 400, 'invalid_grant', 'client_id mismatch for refresh token.');
    return;
  }

  const { issuer, mcpResourceUrl } = loadOAuthConfig();
  const access = await signAccessToken({
    issuer,
    audience: mcpResourceUrl,
    subject: rotated.fresh.user_email,
    clientId: rotated.fresh.client_id,
    scope: rotated.fresh.scope,
  });

  res.json({
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expires_in,
    refresh_token: rotated.fresh.token,
    scope: rotated.fresh.scope,
  });
}

async function issueTokens(
  res: Response,
  input: { clientId: string; userEmail: string; scope: string },
): Promise<void> {
  const { issuer, mcpResourceUrl } = loadOAuthConfig();

  const access = await signAccessToken({
    issuer,
    audience: mcpResourceUrl,
    subject: input.userEmail,
    clientId: input.clientId,
    scope: input.scope,
  });

  const refresh = issueRefreshToken({
    client_id: input.clientId,
    user_email: input.userEmail,
    scope: input.scope,
  });

  res.json({
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expires_in,
    refresh_token: refresh.token,
    scope: input.scope,
  });
}

function sendTokenError(
  res: Response,
  status: number,
  code: string,
  description: string,
): void {
  res.status(status).json({ error: code, error_description: description });
}
