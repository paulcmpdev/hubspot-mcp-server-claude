/**
 * Dynamic Client Registration (RFC 7591).
 *
 * Allows OAuth clients to auto-register with this server, avoiding manual
 * client_id/secret provisioning. Claude Desktop's Custom Connector UI uses
 * this when the user leaves the OAuth Client ID/Secret fields blank.
 *
 * We are intentionally permissive with client metadata — the spec allows
 * many optional fields and we only care about the few we actually use
 * (redirect_uris, token_endpoint_auth_method). Everything else is stored
 * and echoed back without opinion.
 */

import type { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { registerClient } from './store.js';
import { logger } from '../logger.js';

// Relaxed schema: the only hard requirement is ≥1 redirect_uri.
// We accept any string for redirect URIs (supports custom schemes used by
// native apps) and any string for token_endpoint_auth_method.
const RegistrationRequestSchema = z
  .object({
    client_name: z.string().optional(),
    redirect_uris: z.array(z.string().min(1)).min(1),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    scope: z.string().optional(),
  })
  .passthrough();

const SUPPORTED_AUTH_METHODS = new Set([
  'none',
  'client_secret_basic',
  'client_secret_post',
]);

export function registerDcrRoute(router: Router): void {
  router.post('/register', (req, res) => {
    const parsed = RegistrationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        {
          body: req.body,
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        'DCR request failed validation',
      );
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; '),
      });
      return;
    }

    const input = parsed.data;

    // Normalize auth method: if client requests an unsupported method, quietly
    // downgrade to 'none' (public client + PKCE). Spec-compliant DCR servers
    // may do this, and it's strictly safer than minting a fake secret.
    let authMethod = input.token_endpoint_auth_method ?? 'none';
    if (!SUPPORTED_AUTH_METHODS.has(authMethod)) {
      logger.info(
        { requested: authMethod },
        'DCR: client requested unsupported auth method; downgrading to "none"',
      );
      authMethod = 'none';
    }

    // If the client specifically asks for a confidential method, honor it
    // with a real secret so token exchange uses HTTP Basic / client_secret_post.
    let clientSecret: string | undefined;
    if (authMethod === 'client_secret_basic' || authMethod === 'client_secret_post') {
      clientSecret = `cs_${randomBytes(32).toString('base64url')}`;
    }

    const registered = registerClient({
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: authMethod as 'none' | 'client_secret_basic' | 'client_secret_post',
      grant_types: input.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: input.response_types ?? ['code'],
      client_secret: clientSecret,
    });

    logger.info(
      {
        client_id: registered.client_id,
        client_name: registered.client_name,
        redirect_uris: registered.redirect_uris,
        auth_method: registered.token_endpoint_auth_method,
      },
      'DCR: client registered',
    );

    const response: Record<string, unknown> = {
      client_id: registered.client_id,
      client_id_issued_at: Math.floor(registered.created_at / 1000),
      redirect_uris: registered.redirect_uris,
      token_endpoint_auth_method: registered.token_endpoint_auth_method,
      grant_types: registered.grant_types,
      response_types: registered.response_types,
    };
    if (registered.client_name) response.client_name = registered.client_name;
    if (registered.client_secret) response.client_secret = registered.client_secret;

    res.status(201).json(response);
  });
}
