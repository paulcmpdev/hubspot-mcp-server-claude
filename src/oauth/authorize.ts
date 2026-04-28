/**
 * /authorize endpoint — renders a login page (GET) and processes
 * email+password submission (POST). On success, redirects back to the
 * client's redirect_uri with a single-use authorization code.
 *
 * Implements OAuth 2.1 authorization_code with PKCE (S256 required).
 */

import type { Router, Request, Response } from 'express';
import { z } from 'zod';
import { escape as escapeHtml } from 'node:querystring';
import { getClient, issueAuthCode, verifyUserCredentials } from './store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AuthorizeQuerySchema = z
  .object({
    response_type: z.literal('code'),
    client_id: z.string().min(1),
    redirect_uri: z.string().min(1),
    code_challenge: z.string().min(43).max(128),
    code_challenge_method: z.literal('S256'),
    state: z.string().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

type AuthorizeQuery = z.infer<typeof AuthorizeQuerySchema>;

function renderLoginPage(q: AuthorizeQuery, errorMsg?: string): string {
  // Reflect query params back to the form as hidden fields, escaped.
  const hidden = Object.entries(q)
    .map(([k, v]) => (v == null ? '' : `<input type="hidden" name="${k}" value="${escapeHtmlAttr(String(v))}">`))
    .join('\n');
  const err = errorMsg
    ? `<div class="err">${escapeHtmlText(errorMsg)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HubSpot MCP — Sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 380px; margin: 8vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  .sub { color: #777; font-size: .9rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: .85rem; margin-top: 1rem; }
  input[type=email], input[type=password] {
    width: 100%; box-sizing: border-box; padding: .6rem .75rem;
    font-size: 1rem; border: 1px solid #ccc; border-radius: 6px;
    background: transparent; color: inherit;
  }
  button {
    margin-top: 1.25rem; width: 100%; padding: .7rem; font-size: 1rem;
    border: 0; border-radius: 6px; background: #ff7a59; color: white;
    cursor: pointer;
  }
  button:hover { background: #e35d39; }
  .err { color: #c33; font-size: .9rem; margin-top: 1rem; }
  .foot { color: #888; font-size: .8rem; margin-top: 2rem; }
</style>
</head>
<body>
  <h1>HubSpot MCP</h1>
  <div class="sub">Sign in to authorize access.</div>
  <form method="POST" action="/authorize" autocomplete="on">
    ${hidden}
    <label>Email<input type="email" name="email" required autocomplete="username" autofocus></label>
    <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
    <button type="submit">Authorize</button>
    ${err}
  </form>
  <div class="foot">You'll be redirected back to your MCP client on success.</div>
</body></html>`;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlText(s: string): string {
  return escapeHtmlAttr(s);
}

function redirectWithError(
  res: Response,
  redirectUri: string,
  errorCode: string,
  description: string,
  state?: string,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', errorCode);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  res.redirect(302, url.toString());
}

function sendBadRequest(res: Response, description: string): void {
  res.status(400).type('text/plain').send(`Bad request: ${description}`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerAuthorizeRoute(router: Router): void {
  // GET /authorize — render login page after validating client + params
  router.get('/authorize', (req: Request, res: Response) => {
    const parsed = AuthorizeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }

    const client = getClient(parsed.data.client_id);
    if (!client) {
      sendBadRequest(res, 'Unknown client_id. Register via POST /register first.');
      return;
    }
    if (!client.redirect_uris.includes(parsed.data.redirect_uri)) {
      sendBadRequest(res, 'redirect_uri not registered for this client.');
      return;
    }

    res.type('html').send(renderLoginPage(parsed.data));
  });

  // POST /authorize — validate credentials, issue code, redirect
  router.post('/authorize', async (req: Request, res: Response) => {
    const queryLike = { ...req.body };
    delete queryLike.email;
    delete queryLike.password;
    const parsed = AuthorizeQuerySchema.safeParse(queryLike);
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.issues.map((i) => i.message).join('; '));
      return;
    }

    const client = getClient(parsed.data.client_id);
    if (!client || !client.redirect_uris.includes(parsed.data.redirect_uri)) {
      sendBadRequest(res, 'Invalid client_id or redirect_uri.');
      return;
    }

    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.type('html').status(400).send(renderLoginPage(parsed.data, 'Email and password are required.'));
      return;
    }

    const user = await verifyUserCredentials(email, password);
    if (!user) {
      res.type('html').status(401).send(renderLoginPage(parsed.data, 'Incorrect email or password.'));
      return;
    }

    const scope = parsed.data.scope ?? 'mcp';
    const code = issueAuthCode({
      client_id: parsed.data.client_id,
      redirect_uri: parsed.data.redirect_uri,
      code_challenge: parsed.data.code_challenge,
      code_challenge_method: 'S256',
      user_email: user.email,
      scope,
    });

    const redirect = new URL(parsed.data.redirect_uri);
    redirect.searchParams.set('code', code.code);
    if (parsed.data.state) redirect.searchParams.set('state', parsed.data.state);
    res.redirect(302, redirect.toString());
  });

  // Silence an unused-import warning from escape (kept for future use)
  void escapeHtml;
  void redirectWithError;
}
