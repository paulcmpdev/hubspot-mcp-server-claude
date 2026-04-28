# HubSpot MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that wraps HubSpot's CRM v3 REST API. Designed as a remote connector for Claude, Perplexity, or any MCP-compatible client.

Built specifically to bypass the engagement-object restrictions that HubSpot's hosted MCP server (`mcp.hubspot.com`) enforces when "Sensitive Data" is enabled — this server talks to the regular CRM REST API directly via a HubSpot Private App token, so tasks, emails, calls, meetings, and notes remain accessible.

## Capability guarantees

This server exposes **read, create, and update** operations only. It will **never delete** anything:

- The HubSpot REST client (`src/services/hubspot-client.ts`) restricts allowed methods to `GET | POST | PATCH` at the type level — `DELETE` is not in the union and cannot be issued.
- No tool definition wraps a delete operation.
- Updates use `PATCH` (partial), so missing fields are left untouched, not erased.

## Tools

57 tools across 12 areas.

### Engagements (the unblocking goal)

| Tool | Verb |
|---|---|
| `hubspot_search_tasks` | Read |
| `hubspot_get_task` | Read |
| `hubspot_create_task` | Write |
| `hubspot_update_task` | Write |
| `hubspot_search_calls` | Read |
| `hubspot_create_call` | Write |
| `hubspot_search_meetings` | Read |
| `hubspot_create_meeting` | Write |
| `hubspot_search_notes` | Read |
| `hubspot_create_note` | Write |
| `hubspot_search_emails` | Read |
| `hubspot_get_email` | Read |

### Contacts / Companies / Deals / Line Items / Products

For each: `hubspot_search_*`, `hubspot_get_*`, `hubspot_create_*`, `hubspot_update_*`. Line items are typically created with an `associations` arg pointing at a parent deal/quote/invoice. Products are entries in the Products Library used to populate line items.

### Files (File Manager — separate `/files/v3` API)

| Tool | Purpose |
|---|---|
| `hubspot_search_files` | List/search the File Manager. |
| `hubspot_get_file` | Fetch metadata for one file. |
| `hubspot_get_file_signed_url` | Mint a short-lived download URL (required for PRIVATE files). |
| `hubspot_upload_file_from_url` | Async import: HubSpot fetches a public URL and stores it. JSON-only — multipart binary upload is not supported by this server (use HubSpot's `POST /files/v3/files` directly for that). |

Files require the `files` scope on your Private App (separate from CRM scopes).

### Meta

| Tool | Purpose |
|---|---|
| `hubspot_describe_object` | List property definitions for any object type. **Run this first** when working with unfamiliar objects — it tells the model exact property names, types, and dropdown options. |
| `hubspot_list_owners` | Enumerate owners for `hubspot_owner_id` assignment. |

### Analytics — Sales & Pipeline (5 tools)

Roll up over the existing CRM search APIs. No new scopes required.

| Tool | Answers |
|---|---|
| `hubspot_get_pipeline_summary` | Open deals by stage with weighted value. |
| `hubspot_get_deal_velocity` | Avg/median/p90 days to close in a window. |
| `hubspot_get_win_rate` | Win rate, optionally segmented by source/owner/etc. |
| `hubspot_get_owner_activity` | Engagement counts (calls/emails/meetings/notes/tasks) per owner. |
| `hubspot_get_deal_attribution` | Source, first/last touch, originating campaign for one deal. |

### Analytics — Email & Marketing Campaigns (6 tools)

Marketing Hub Pro+. Uses `/marketing/v3/emails` and `/marketing/v3/campaigns`.

| Tool | Answers |
|---|---|
| `hubspot_list_email_campaigns` | List marketing emails. |
| `hubspot_get_email_campaign_stats` | Sends/opens/clicks/bounces for one email. |
| `hubspot_aggregate_email_stats` | Aggregate stats across emails in a window. |
| `hubspot_list_marketing_campaigns` | List campaigns. |
| `hubspot_get_marketing_campaign_metrics` | Revenue/contacts/sessions for one campaign. |
| `hubspot_get_top_campaigns_by_revenue` | Top N campaigns by influenced/first-/last-touch revenue. |

### Analytics — Forms & Web (4 tools)

Requires `forms` scope and the legacy `/analytics/v2/...` web reports (works on Enterprise).

| Tool | Answers |
|---|---|
| `hubspot_list_forms` | List forms. |
| `hubspot_get_form_submissions` | Submissions for one form. |
| `hubspot_get_traffic_summary` | Sessions/visitors/contacts by traffic source. |
| `hubspot_get_top_pages` | Top pages by views in a window. |

### Analytics — Behavioral Events & Sequences (4 tools)

Behavioral events: Marketing Hub Enterprise + `behavioral_events.event_definitions.read_write` scope.
Sequences: Sales Hub Enterprise.

| Tool | Answers |
|---|---|
| `hubspot_list_event_types` | What custom events do we track? |
| `hubspot_query_events` | Occurrences of a custom event in a window. |
| `hubspot_list_sequences` | What sales sequences are running? |
| `hubspot_get_sequence_stats` | Reply/meeting rates for a sequence. |

All tools support `response_format: "markdown" | "json"`.

## Setup

### Prerequisites

- Node.js 18+ (or Docker)
- A HubSpot Private App access token. Create at **Settings → Integrations → Private Apps → Create app**.

### Required HubSpot Private App scopes

Read + write across:
- `crm.objects.contacts`, `crm.objects.companies`, `crm.objects.deals`, `crm.objects.line_items`, `crm.objects.quotes`
- Engagements: tasks, calls, meetings, notes (these checkboxes appear in the scope picker)
- `sales-email-read` (for engagement emails)
- `crm.lists`, `crm.objects.owners`
- Read on `crm.schemas.*` for the object types you care about
- `files` (read + write) — required for the four `hubspot_*_file*` tools. If you skip this scope, the file tools return 403; everything else still works.
- `forms` (read) — required for `hubspot_list_forms` and `hubspot_get_form_submissions`.
- `marketing-email` and `marketing.campaigns.read` — required for the six email/campaign analytics tools (Marketing Hub Pro+).
- `behavioral_events.event_definitions.read_write` — required for `hubspot_list_event_types` and `hubspot_query_events` (Marketing Hub Enterprise).
- `sales-email-read` already covers most sequence reads; if `hubspot_list_sequences` returns a scope error, your portal needs the `automation` scope too.

No delete scopes are required — this server never issues DELETE requests.

### Install and configure

```bash
git clone https://github.com/paulcmpdev/hubspot-mcp-server-claude.git
cd hubspot-mcp-server-claude
npm install
cp .env.example .env
# Edit .env — see below
```

Required environment variables:

| Variable | Purpose |
|---|---|
| `HUBSPOT_PRIVATE_APP_TOKEN` | Your HubSpot Private App access token (`pat-na1-...`) |
| `OAUTH_ISSUER_URL` | Public base URL of this server (e.g. `https://your-app.up.railway.app`), no trailing slash |
| `OAUTH_JWT_SECRET` | Signing secret for access-token JWTs (32+ bytes random) |
| `OAUTH_USERS` | JSON array of `{"email", "password_hash"}` — humans allowed to log in |

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `MCP_API_KEY` | _(unset)_ | Static Bearer key accepted alongside OAuth JWTs — debug/curl fallback |
| `PORT` | `3100` | HTTP port (chosen to not conflict with the Printavo MCP server, which defaults to 3000) |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `LOG_LEVEL` | `info` | Pino log level |
| `NODE_ENV` | `development` | `production` switches Pino to JSON |

Generate secrets:

```bash
# JWT signing secret
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# bcrypt hash for a new user
node -e "console.log(require('bcryptjs').hashSync('the-password', 12))"
```

## Authentication

Two auth methods on `POST /mcp`:

1. **OAuth 2.1 Bearer (primary, used by Claude).** Clients discover the authorization server via `/.well-known/oauth-protected-resource`, optionally auto-register via `POST /register` (RFC 7591 Dynamic Client Registration), redirect the user to `/authorize` for email/password login + PKCE, then exchange the code at `/token` for an HS256 JWT access token and rotating refresh token.
2. **Static `MCP_API_KEY` (optional).** If the env var is set, any matching Bearer token is accepted. Intended for curl testing, CI, or recovery — leave unset in production.

All OAuth state (registered clients, auth codes, refresh tokens) is in-memory; a redeploy forces re-authentication. Acceptable for personal/single-user setups; swap in a Postgres-backed `src/oauth/store.ts` for distribution.

## Run

```bash
# Local dev — auto-reload
npm run dev

# Build + run
npm run build
npm start

# Tests
npm test
```

## Deploy to Railway

1. Push this repo to GitHub.
2. New Railway project → Deploy from GitHub repo.
3. Add the required environment variables (see table above). Railway sets `PORT` automatically.
4. Set `OAUTH_ISSUER_URL` to your Railway public URL once issued (e.g. `https://your-service.up.railway.app`). Redeploy after.
5. Connect from Claude Desktop: **Settings → Connectors → Add custom connector**, point it at `https://your-service.up.railway.app/mcp`, leave client ID/secret blank (DCR will auto-register).

## Adding more users

1. Generate a bcrypt hash: `node -e "console.log(require('bcryptjs').hashSync('the-password', 12))"`
2. Append to `OAUTH_USERS` JSON array.
3. Restart / redeploy.

## Architecture

```
src/
  index.ts            – Express app, MCP transport wiring, bootstrap
  auth.ts             – Bearer auth middleware (JWT + static fallback)
  constants.ts        – Rate limits, page sizes, response cap
  logger.ts           – Pino → stderr
  types.ts            – HubSpot REST shapes
  oauth/              – OAuth 2.1 + PKCE + DCR (RFC 7591)
  services/
    hubspot-client.ts – Rate-limited REST client (GET/POST/PATCH only)
    formatters.ts     – Markdown rendering for objects/lists/properties
  schemas/
    common.ts         – Shared Zod fragments (filters, pagination, etc.)
  tools/
    _factories.ts     – search/get/create/update tool builders
    _helpers.ts       – CallToolResult helpers
    engagements.ts    – tasks, calls, meetings, notes, emails
    contacts.ts       – contact CRUD-minus-D
    companies.ts      – company CRUD-minus-D
    deals.ts          – deal CRUD-minus-D
    line-items.ts     – line item CRUD-minus-D
    products.ts       – product CRUD-minus-D
    files.ts          – File Manager: search, get, signed URL, URL import
    meta.ts           – describe_object, list_owners
    analytics-sales.ts     – pipeline, velocity, win rate, owner activity, attribution
    analytics-marketing.ts – email + marketing campaign stats
    analytics-web.ts       – forms + legacy /analytics/v2 web reports
    analytics-events.ts    – behavioral events + sales sequences
    index.ts          – aggregate registration
tests/                – vitest suites
```

## License

MIT — see [LICENSE](./LICENSE).
