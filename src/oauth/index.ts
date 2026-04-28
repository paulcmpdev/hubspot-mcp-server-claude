/**
 * Aggregate OAuth route registration.
 */

import type { Router } from 'express';
import { registerMetadataRoutes } from './metadata.js';
import { registerDcrRoute } from './dcr.js';
import { registerAuthorizeRoute } from './authorize.js';
import { registerTokenRoute } from './token.js';

export { wwwAuthenticateHeader } from './metadata.js';
export { verifyAccessToken } from './jwt.js';
export { loadOAuthConfig } from './config.js';

export function registerOAuthRoutes(router: Router): void {
  registerMetadataRoutes(router);
  registerDcrRoute(router);
  registerAuthorizeRoute(router);
  registerTokenRoute(router);
}
