/**
 * End-to-end OAuth flow tests against the Express app.
 *
 * Spins up the app on an ephemeral port and drives it via Node's built-in
 * fetch. Verifies metadata discovery, DCR, the auth_code + PKCE flow, the
 * refresh-token rotation, and that /mcp surfaces our server name.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import { buildApp } from '../src/index.js';
import { _resetOAuthStoreForTests, _resetUserCacheForTests } from '../src/oauth/store.js';

let server: http.Server;
let baseUrl: string;

const TEST_USER_EMAIL = 'tester@example.com';
const TEST_USER_PASSWORD = 'hunter2-hunter2';

beforeAll(async () => {
  process.env.HUBSPOT_PRIVATE_APP_TOKEN = 'pat-na1-fake-test-token';
  process.env.OAUTH_JWT_SECRET = 'test-jwt-secret-test-jwt-secret-000';
  process.env.OAUTH_USERS = JSON.stringify([
    { email: TEST_USER_EMAIL, password_hash: bcrypt.hashSync(TEST_USER_PASSWORD, 8) },
  ]);

  const app = buildApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not bind ephemeral port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  process.env.OAUTH_ISSUER_URL = baseUrl;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  _resetOAuthStoreForTests();
  _resetUserCacheForTests();
});

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('OAuth metadata endpoints', () => {
  it('serves /.well-known/oauth-authorization-server', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe(baseUrl);
    expect(body.authorization_endpoint).toBe(`${baseUrl}/authorize`);
    expect(body.token_endpoint).toBe(`${baseUrl}/token`);
    expect(body.registration_endpoint).toBe(`${baseUrl}/register`);
    expect(body.code_challenge_methods_supported).toContain('S256');
  });

  it('serves /.well-known/oauth-protected-resource', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(`${baseUrl}/mcp`);
    expect(body.authorization_servers).toContain(baseUrl);
  });
});

describe('/mcp 401 includes WWW-Authenticate with resource metadata', () => {
  it('advertises our oauth metadata URL', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const auth = res.headers.get('www-authenticate');
    expect(auth).toMatch(/resource_metadata=/);
    expect(auth).toMatch(/\.well-known\/oauth-protected-resource/);
  });
});

describe('Dynamic Client Registration + authorization code flow', () => {
  it('registers a client and completes the full auth_code + PKCE + token flow', async () => {
    const regRes = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test-client',
        redirect_uris: ['http://localhost:54321/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    expect(regRes.status).toBe(201);
    const regBody = await regRes.json();
    expect(regBody.client_id).toMatch(/^mcp_/);
    const clientId: string = regBody.client_id;

    const { verifier, challenge } = pkcePair();

    const authRes = await fetch(`${baseUrl}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'http://localhost:54321/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD,
      }).toString(),
    });
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get('location')!;
    expect(location).toContain('http://localhost:54321/callback');
    const loc = new URL(location);
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('xyz');

    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'http://localhost:54321/callback',
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.refresh_token).toMatch(/^rt_/);
    expect(tokenBody.expires_in).toBeGreaterThan(0);

    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '0.0.0' },
        },
      }),
    });
    expect(mcpRes.status).toBe(200);
    const mcp = await mcpRes.json();
    expect(mcp.result?.serverInfo?.name).toBe('hubspot-mcp-server-claude');
  });

  it('rejects wrong PKCE verifier', async () => {
    const regRes = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost:54321/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const { client_id } = await regRes.json();
    const { challenge } = pkcePair();

    const authRes = await fetch(`${baseUrl}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri: 'http://localhost:54321/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD,
      }).toString(),
    });
    const loc = new URL(authRes.headers.get('location')!);
    const code = loc.searchParams.get('code')!;

    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:54321/callback',
        client_id,
        code_verifier: 'wrong-verifier-' + 'x'.repeat(40),
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
    const body = await tokenRes.json();
    expect(body.error).toBe('invalid_grant');
  });

  it('rejects wrong password', async () => {
    const regRes = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost:54321/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const { client_id } = await regRes.json();
    const { challenge } = pkcePair();

    const res = await fetch(`${baseUrl}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri: 'http://localhost:54321/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        email: TEST_USER_EMAIL,
        password: 'wrong-password',
      }).toString(),
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toMatch(/Incorrect email or password/);
  });
});

describe('Refresh token grant', () => {
  it('rotates and issues a new access token', async () => {
    const regRes = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost:54321/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const { client_id } = await regRes.json();
    const { verifier, challenge } = pkcePair();

    const authRes = await fetch(`${baseUrl}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri: 'http://localhost:54321/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD,
      }).toString(),
    });
    const loc = new URL(authRes.headers.get('location')!);

    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: loc.searchParams.get('code')!,
        redirect_uri: 'http://localhost:54321/callback',
        client_id,
        code_verifier: verifier,
      }).toString(),
    });
    const { refresh_token } = await tokenRes.json();

    const refreshRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
        client_id,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = await refreshRes.json();
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.token_type).toBe('Bearer');
    expect(refreshed.refresh_token).toMatch(/^rt_/);
    expect(refreshed.refresh_token).not.toBe(refresh_token);

    const replayRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
        client_id,
      }).toString(),
    });
    expect(replayRes.status).toBe(400);
  });
});
