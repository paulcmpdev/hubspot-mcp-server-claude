/**
 * JWT helpers for OAuth access tokens.
 *
 * Access tokens are HS256-signed JWTs with claims:
 *   iss: our issuer URL
 *   aud: the MCP resource URL
 *   sub: the user's email
 *   azp: the authorized OAuth client_id
 *   scope: space-separated scopes
 *   exp / iat: standard expiry
 */

import { SignJWT, jwtVerify } from 'jose';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

function getSecret(): Uint8Array {
  const raw = process.env.OAUTH_JWT_SECRET;
  if (!raw) throw new Error('OAUTH_JWT_SECRET is not configured');
  return new TextEncoder().encode(raw);
}

export interface AccessTokenClaims {
  sub: string;
  azp: string;
  scope: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

interface IssueInput {
  issuer: string;
  audience: string;
  subject: string;
  clientId: string;
  scope: string;
}

export async function signAccessToken(input: IssueInput): Promise<{
  token: string;
  expires_in: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ACCESS_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ azp: input.clientId, scope: input.scope })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(getSecret());
  return { token, expires_in: ACCESS_TOKEN_TTL_SECONDS };
}

export async function verifyAccessToken(
  token: string,
  expected: { issuer: string; audience: string },
): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: expected.issuer,
    audience: expected.audience,
    algorithms: ['HS256'],
  });
  return payload as unknown as AccessTokenClaims;
}
