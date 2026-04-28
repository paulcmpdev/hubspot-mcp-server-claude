import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { buildMcpAuthMiddleware } from '../src/auth.js';
import { signAccessToken } from '../src/oauth/jwt.js';

function mockReq(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  };
}

const ISSUER = 'https://example.test';
const STATIC_KEY = 'super-secret-test-key-1234567890';

beforeEach(() => {
  process.env.OAUTH_ISSUER_URL = ISSUER;
  process.env.OAUTH_JWT_SECRET = 'test-jwt-secret-test-jwt-secret-000';
});

describe('mcpAuthMiddleware — static key fallback', () => {
  const middleware = buildMcpAuthMiddleware({ staticApiKey: STATIC_KEY });

  it('rejects requests with no auth header', async () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    await middleware(mockReq({}), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers['WWW-Authenticate']).toMatch(/Bearer/);
  });

  it('rejects an invalid Bearer token', async () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    await middleware(mockReq({ authorization: 'Bearer wrong' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid static Bearer token', async () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    await middleware(mockReq({ authorization: `Bearer ${STATIC_KEY}` }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('accepts a valid x-api-key header', async () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    await middleware(mockReq({ 'x-api-key': STATIC_KEY }), res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('mcpAuthMiddleware — JWT path', () => {
  const middleware = buildMcpAuthMiddleware({ staticApiKey: STATIC_KEY });

  it('accepts a valid JWT issued by this server', async () => {
    const { token } = await signAccessToken({
      issuer: ISSUER,
      audience: `${ISSUER}/mcp`,
      subject: 'user@example.com',
      clientId: 'mcp_test',
      scope: 'mcp',
    });
    const next: NextFunction = vi.fn();
    const res = mockRes();
    await middleware(mockReq({ authorization: `Bearer ${token}` }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects JWT with wrong audience', async () => {
    const { token } = await signAccessToken({
      issuer: ISSUER,
      audience: 'https://not-our-server.example/mcp',
      subject: 'user@example.com',
      clientId: 'mcp_test',
      scope: 'mcp',
    });
    const next: NextFunction = vi.fn();
    const res = mockRes();
    await middleware(mockReq({ authorization: `Bearer ${token}` }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('mcpAuthMiddleware — no static fallback', () => {
  it('rejects static-style tokens when no staticApiKey configured', async () => {
    const middleware = buildMcpAuthMiddleware({ staticApiKey: undefined });
    const next: NextFunction = vi.fn();
    const res = mockRes();
    await middleware(mockReq({ authorization: `Bearer ${STATIC_KEY}` }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
