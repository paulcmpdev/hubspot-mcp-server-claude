/**
 * OAuth 2.1 & MCP metadata discovery endpoints.
 *
 * Per the MCP Authorization spec, the resource server advertises its
 * authorization server via `/.well-known/oauth-protected-resource`, and
 * the authorization server publishes its endpoints via
 * `/.well-known/oauth-authorization-server` (RFC 8414).
 */

import type { Router } from 'express';
import { loadOAuthConfig } from './config.js';

export function registerMetadataRoutes(router: Router): void {
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    const { issuer } = loadOAuthConfig();
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [
        'none',
        'client_secret_basic',
        'client_secret_post',
      ],
      scopes_supported: ['mcp'],
    });
  });

  router.get('/.well-known/oauth-protected-resource', (_req, res) => {
    const { issuer, mcpResourceUrl } = loadOAuthConfig();
    res.json({
      resource: mcpResourceUrl,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    });
  });
}

/** The WWW-Authenticate header value for 401 responses on /mcp. */
export function wwwAuthenticateHeader(): string {
  const { issuer, mcpResourceUrl } = loadOAuthConfig();
  const metadataUrl = `${issuer}/.well-known/oauth-protected-resource`;
  return `Bearer realm="mcp", resource_metadata="${metadataUrl}", resource="${mcpResourceUrl}"`;
}
