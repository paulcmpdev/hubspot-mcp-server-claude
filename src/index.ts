/**
 * HubSpot MCP Server entrypoint.
 *
 * Streamable HTTP transport in stateless mode (a fresh McpServer + transport
 * per request). Suitable for horizontal scaling and for being used as a
 * Claude remote connector.
 *
 * Hard guarantee: read/create/update only — no DELETE operations are exposed
 * by any tool, and the underlying REST client refuses any method other than
 * GET, POST, or PATCH.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ALL_TOOL_NAMES, registerAllTools } from './tools/index.js';
import { buildMcpAuthMiddleware } from './auth.js';
import { logger } from './logger.js';
import { registerOAuthRoutes } from './oauth/index.js';
import { loadUsers } from './oauth/store.js';

const SERVER_NAME = 'hubspot-mcp-server-claude';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  'HUBSPOT_PRIVATE_APP_TOKEN',
  'OAUTH_ISSUER_URL',
  'OAUTH_JWT_SECRET',
  'OAUTH_USERS',
] as const;

function validateEnv(): void {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    logger.fatal({ missing }, 'Missing required environment variables');
    process.exit(1);
  }

  try {
    const users = loadUsers();
    if (users.length === 0) {
      logger.fatal('OAUTH_USERS must contain at least one user');
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.fatal({ err: msg }, 'OAUTH_USERS is invalid');
    process.exit(1);
  }

  if (!process.env.MCP_API_KEY) {
    logger.info('MCP_API_KEY not set — OAuth tokens are required (no debug fallback).');
  }
}

// ---------------------------------------------------------------------------
// MCP server factory — fresh instance per request (stateless)
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAllTools(server);
  return server;
}

// ---------------------------------------------------------------------------
// CORS — configurable origins (comma-separated, * to allow all)
// ---------------------------------------------------------------------------

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const allowed = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());
  const origin = req.headers.origin;

  let allowOrigin: string | undefined;
  if (allowed.includes('*')) {
    allowOrigin = '*';
  } else if (origin && allowed.includes(origin)) {
    allowOrigin = origin;
  }

  if (allowOrigin) res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Accept, mcp-session-id, x-api-key',
  );
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(corsMiddleware);

  // OAuth routes (metadata, DCR, authorize, token) — no auth required on these.
  registerOAuthRoutes(app);

  const mcpAuthMiddleware = buildMcpAuthMiddleware({
    staticApiKey: process.env.MCP_API_KEY,
  });

  // Health check — public
  app.get('/', (_req, res) => {
    const issuer = process.env.OAUTH_ISSUER_URL ?? '';
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      status: 'ok',
      mode: 'stateless',
      transport: 'streamable-http',
      endpoint: '/mcp',
      auth: {
        oauth: {
          metadata: issuer ? `${issuer.replace(/\/$/, '')}/.well-known/oauth-protected-resource` : null,
        },
        static_fallback: Boolean(process.env.MCP_API_KEY),
      },
      tools: ALL_TOOL_NAMES,
      toolCount: ALL_TOOL_NAMES.length,
      capabilities: ['read', 'create', 'update'],
      operations_disabled: ['delete'],
    });
  });

  // POST /mcp — main tool calls and initialization
  app.post('/mcp', mcpAuthMiddleware, async (req, res) => {
    const reqLogger = logger.child({ reqId: req.headers['x-request-id'] ?? cryptoRandomId() });
    let transport: StreamableHTTPServerTransport | undefined;
    let server: McpServer | undefined;
    try {
      server = createMcpServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport?.close().catch(() => {});
        server?.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      reqLogger.error({ err: error }, 'MCP request failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET /mcp — endpoint validation only (no SSE in stateless mode)
  app.get('/mcp', mcpAuthMiddleware, (_req, res) => {
    res.status(200).json({
      jsonrpc: '2.0',
      result: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        status: 'ok',
        message: 'MCP endpoint active. Use POST for tool calls.',
      },
      id: null,
    });
  });

  // DELETE /mcp — session termination is not applicable in stateless mode
  app.delete('/mcp', mcpAuthMiddleware, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method Not Allowed: Session management is not supported in stateless mode.',
      },
      id: null,
    });
  });

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found. MCP endpoint is at POST /mcp' });
  });

  return app;
}

function cryptoRandomId(): string {
  return Math.random().toString(16).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function start(): void {
  validateEnv();

  const port = parseInt(process.env.PORT ?? '3100', 10);
  const app = buildApp();
  const httpServer = app.listen(port, () => {
    logger.info(
      { port, tools: ALL_TOOL_NAMES.length, mode: 'stateless' },
      `${SERVER_NAME} listening`,
    );
  });

  function shutdown(signal: string): void {
    logger.info({ signal }, 'Shutting down gracefully');
    httpServer.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/dist/index.js') === true ||
  process.argv[1]?.endsWith('/src/index.ts') === true;

if (isDirectInvocation) {
  start();
}
