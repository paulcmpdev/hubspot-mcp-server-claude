/**
 * OAuth configuration derived from environment variables.
 *
 * The issuer URL is the public base URL of this server — required for
 * token claims and metadata discovery. It must be HTTPS in production.
 */

export interface OAuthConfig {
  /** Public base URL, e.g. https://printavo-mcp-server-claude-production.up.railway.app */
  issuer: string;
  /** MCP resource endpoint, used as the `aud` claim and resource metadata URL */
  mcpResourceUrl: string;
}

export function loadOAuthConfig(): OAuthConfig {
  const issuer = (process.env.OAUTH_ISSUER_URL ?? '').replace(/\/$/, '');
  if (!issuer) {
    throw new Error(
      'OAUTH_ISSUER_URL must be set to the public base URL of this server (e.g. https://your-app.up.railway.app)',
    );
  }
  return {
    issuer,
    mcpResourceUrl: `${issuer}/mcp`,
  };
}
