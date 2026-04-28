/**
 * Phase 2 — Email & Marketing Campaign Analytics.
 *
 *   - hubspot_list_email_campaigns           → GET /marketing/v3/emails
 *   - hubspot_get_email_campaign_stats       → GET /marketing/v3/emails/{id}/statistics
 *   - hubspot_aggregate_email_stats          → GET /marketing/v3/emails/statistics/list
 *   - hubspot_list_marketing_campaigns       → GET /marketing/v3/campaigns
 *   - hubspot_get_marketing_campaign_metrics → GET /marketing/v3/campaigns/{id}/reports/metrics
 *   - hubspot_get_top_campaigns_by_revenue   → list + per-campaign metrics, sort by revenue
 *
 * Marketing Hub Pro+ required for the Marketing API surfaces.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hubspotRequest } from '../services/hubspot-client.js';
import { truncate } from '../services/formatters.js';
import { toolError, toolResult } from './_helpers.js';
import { After, Limit, ResponseFormat, TimeWindow, resolveTimeWindow, pct } from '../schemas/common.js';
import type {
  CollectionResponse,
  HubSpotCampaignMetrics,
  HubSpotEmailStatistics,
  HubSpotMarketingCampaign,
  HubSpotMarketingEmail,
} from '../types.js';

function fmtMoney(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

function emailStatsTable(stats: HubSpotEmailStatistics): string {
  const c = stats.counters ?? {};
  const r = stats.ratios ?? {};
  const lines = [
    `- **Sent**: ${fmtNum(c.sent)}`,
    `- **Delivered**: ${fmtNum(c.delivered)} (${pct(r.deliveredratio ?? 0)})`,
    `- **Open**: ${fmtNum(c.open)} (${pct(r.openratio ?? 0)})`,
    `- **Click**: ${fmtNum(c.click)} (${pct(r.clickratio ?? 0)})`,
    `- **Bounce**: ${fmtNum(c.bounce)} (${pct(r.bounceratio ?? 0)})`,
    `- **Unsubscribed**: ${fmtNum(c.unsubscribed)} (${pct(r.unsubscribedratio ?? 0)})`,
  ];
  if (c.spamreport !== undefined) lines.push(`- **Spam reports**: ${fmtNum(c.spamreport)}`);
  if (c.reply !== undefined) lines.push(`- **Reply**: ${fmtNum(c.reply)}`);
  return lines.join('\n');
}

export function registerMarketingAnalyticsTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // hubspot_list_email_campaigns
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_list_email_campaigns',
    {
      title: 'List marketing emails',
      description:
        'List marketing emails (newsletters, broadcasts, automation) from the Marketing Hub. ' +
        'Filter by `state` (PUBLISHED, DRAFT, etc.), `type`, or `name`. Paginated via `after`.',
      inputSchema: {
        state: z.string().optional().describe('Email state, e.g. PUBLISHED, DRAFT, AUTOMATED.'),
        type: z.string().optional().describe('Email type filter.'),
        name: z.string().optional().describe('Substring match on email name.'),
        sort: z.string().optional().describe('Sort field, prefix `-` for desc (e.g. `-publishDate`).'),
        limit: Limit,
        after: After,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const response = await hubspotRequest<CollectionResponse<HubSpotMarketingEmail>>({
          path: '/marketing/v3/emails',
          query: {
            state: args.state,
            type: args.type,
            name: args.name,
            sort: args.sort,
            limit: args.limit,
            after: args.after,
            includeStats: true,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        if (response.results.length === 0) return toolResult('## Marketing emails\n\n_No results._');

        const md = [
          '## Marketing emails',
          '',
          `_${response.results.length} result(s)._`,
          '',
          `| id | name | state | type | published |`,
          `| --- | --- | --- | --- | --- |`,
          ...response.results.map(
            (e) =>
              `| ${e.id} | ${(e.name ?? '—').replace(/\|/g, '\\|')} | ${e.state ?? '—'} | ${e.type ?? '—'} | ${e.publishDate ?? '—'} |`,
          ),
        ];
        const cursor = response.paging?.next?.after;
        if (cursor) md.push('', `_Next cursor: \`${cursor}\`_`);
        return toolResult(truncate(md.join('\n')), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_email_campaign_stats
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_email_campaign_stats',
    {
      title: 'Marketing email stats — single campaign',
      description:
        'Fetch send/delivery/open/click/bounce/unsubscribe stats for one marketing email by ID. ' +
        'Use `hubspot_list_email_campaigns` to find the email ID.',
      inputSchema: {
        emailId: z.string().min(1).describe('The marketing email ID.'),
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const stats = await hubspotRequest<HubSpotEmailStatistics>({
          path: `/marketing/v3/emails/${encodeURIComponent(args.emailId)}/statistics`,
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(stats, null, 2)), stats);
        }
        return toolResult(
          truncate([`## Email stats — \`${args.emailId}\``, '', emailStatsTable(stats)].join('\n')),
          stats,
        );
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_aggregate_email_stats
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_aggregate_email_stats',
    {
      title: 'Aggregate email stats over a window',
      description:
        'Aggregate send/open/click/bounce/unsubscribe stats across all marketing emails sent in ' +
        'a time window. Optionally restrict to specific email IDs. Defaults to last 30 days.',
      inputSchema: {
        emailIds: z
          .array(z.string().min(1))
          .optional()
          .describe('Restrict to specific email IDs. Defaults to all emails in the window.'),
        property: z.string().optional().describe('Property filter (e.g. emailType).'),
        ...TimeWindow,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const win = resolveTimeWindow({ start: args.start, end: args.end });
        const query: Record<string, string | number | boolean | undefined> = {
          startTimestamp: win.startIso,
          endTimestamp: win.endIso,
        };
        if (args.emailIds && args.emailIds.length > 0) {
          // The list endpoint accepts a comma-separated emailIds parameter on most HubSpot APIs.
          query.emailIds = args.emailIds.join(',');
        }
        if (args.property) query.property = args.property;

        const response = await hubspotRequest<{
          aggregate?: HubSpotEmailStatistics;
          emails?: HubSpotMarketingEmail[];
        }>({
          path: '/marketing/v3/emails/statistics/list',
          query,
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        const lines = [
          `## Aggregate email stats — ${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)}`,
          '',
        ];
        if (response.aggregate) {
          lines.push(emailStatsTable(response.aggregate));
        } else {
          lines.push('_(no aggregate returned — see emails list below)_');
        }
        if (response.emails && response.emails.length > 0) {
          lines.push('', '### Per-email', '', `| id | name | sent | open | click |`, `| --- | --- | ---: | ---: | ---: |`);
          for (const e of response.emails) {
            const c = e.stats?.counters ?? {};
            lines.push(
              `| ${e.id} | ${(e.name ?? '—').replace(/\|/g, '\\|')} | ${fmtNum(c.sent)} | ${fmtNum(c.open)} | ${fmtNum(c.click)} |`,
            );
          }
        }
        return toolResult(truncate(lines.join('\n')), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_list_marketing_campaigns
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_list_marketing_campaigns',
    {
      title: 'List marketing campaigns',
      description:
        'List marketing campaigns from /marketing/v3/campaigns. Each campaign has a name, owner, ' +
        'budget, start/end date, and goal. Use `hubspot_get_marketing_campaign_metrics` for ' +
        'performance numbers.',
      inputSchema: {
        name: z.string().optional().describe('Substring match on campaign name.'),
        sort: z.string().optional().describe('Sort field, prefix `-` for desc.'),
        limit: Limit,
        after: After,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const response = await hubspotRequest<CollectionResponse<HubSpotMarketingCampaign>>({
          path: '/marketing/v3/campaigns',
          query: {
            name: args.name,
            sort: args.sort,
            limit: args.limit,
            after: args.after,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        if (response.results.length === 0) return toolResult('## Marketing campaigns\n\n_No results._');

        const md = [
          '## Marketing campaigns',
          '',
          `_${response.results.length} result(s)._`,
          '',
          `| id | name | start | end | budget |`,
          `| --- | --- | --- | --- | ---: |`,
          ...response.results.map((c) => {
            const p = c.properties ?? {};
            return `| ${c.id} | ${(p.hs_name ?? '—')} | ${p.hs_start_date ?? '—'} | ${p.hs_end_date ?? '—'} | ${fmtMoney(Number(p.hs_budget_total))} |`;
          }),
        ];
        const cursor = response.paging?.next?.after;
        if (cursor) md.push('', `_Next cursor: \`${cursor}\`_`);
        return toolResult(truncate(md.join('\n')), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_marketing_campaign_metrics
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_marketing_campaign_metrics',
    {
      title: 'Marketing campaign metrics',
      description:
        'Fetch performance metrics for one marketing campaign — influenced revenue, contacts ' +
        '(first/last touch / influenced), sessions, and other tracked KPIs over a date range. ' +
        'Defaults to last 30 days.',
      inputSchema: {
        campaignId: z.string().min(1).describe('The marketing campaign ID/GUID.'),
        ...TimeWindow,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const win = resolveTimeWindow({ start: args.start, end: args.end });
        const metrics = await hubspotRequest<HubSpotCampaignMetrics>({
          path: `/marketing/v3/campaigns/${encodeURIComponent(args.campaignId)}/reports/metrics`,
          query: {
            startDate: win.startIso.slice(0, 10),
            endDate: win.endIso.slice(0, 10),
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(metrics, null, 2)), metrics);
        }

        const m = metrics.metrics ?? {};
        const md = [
          `## Campaign metrics — \`${args.campaignId}\``,
          `_${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)}_`,
          '',
          `- **Sessions**: ${fmtNum(m.sessions?.total)}`,
          `- **Contacts (first-touch)**: ${fmtNum(m.contacts?.firstTouch)}`,
          `- **Contacts (last-touch)**: ${fmtNum(m.contacts?.lastTouch)}`,
          `- **Contacts (influenced)**: ${fmtNum(m.contacts?.influenced)}`,
          `- **Revenue (first-touch)**: ${fmtMoney(m.revenue?.firstTouch)}`,
          `- **Revenue (last-touch)**: ${fmtMoney(m.revenue?.lastTouch)}`,
          `- **Revenue (influenced)**: ${fmtMoney(m.revenue?.influenced)}`,
        ].join('\n');
        return toolResult(truncate(md), metrics);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_top_campaigns_by_revenue
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_top_campaigns_by_revenue',
    {
      title: 'Top campaigns by revenue (influenced)',
      description:
        'Combine `list_marketing_campaigns` + per-campaign metrics, sort by influenced revenue, ' +
        'return the top N. Slow on portals with many campaigns (one metrics call per campaign), ' +
        'so cap with `topN`. Defaults to last 30 days, top 10.',
      inputSchema: {
        topN: z.number().int().min(1).max(50).optional().describe('Top N to return (1-50). Default 10.'),
        attribution: z
          .enum(['influenced', 'firstTouch', 'lastTouch'])
          .optional()
          .describe('Which revenue figure to rank by. Default: influenced.'),
        ...TimeWindow,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const topN = args.topN ?? 10;
        const attr = args.attribution ?? 'influenced';
        const win = resolveTimeWindow({ start: args.start, end: args.end });

        // Fetch campaigns (single page — for huge portals user can rerun with smaller window).
        const campaignsResp = await hubspotRequest<CollectionResponse<HubSpotMarketingCampaign>>({
          path: '/marketing/v3/campaigns',
          query: { limit: 100 },
        });

        // Fan out metrics calls in parallel batches of 5 to stay under the rate limit.
        const results: Array<{ campaign: HubSpotMarketingCampaign; revenue: number }> = [];
        const campaigns = campaignsResp.results;
        const BATCH = 5;
        for (let i = 0; i < campaigns.length; i += BATCH) {
          const batch = campaigns.slice(i, i + BATCH);
          const settled = await Promise.allSettled(
            batch.map(async (c) => {
              const m = await hubspotRequest<HubSpotCampaignMetrics>({
                path: `/marketing/v3/campaigns/${encodeURIComponent(c.id)}/reports/metrics`,
                query: {
                  startDate: win.startIso.slice(0, 10),
                  endDate: win.endIso.slice(0, 10),
                },
              });
              return {
                campaign: c,
                revenue: Number(m.metrics?.revenue?.[attr] ?? 0) || 0,
              };
            }),
          );
          for (const s of settled) if (s.status === 'fulfilled') results.push(s.value);
        }

        const sorted = results.sort((a, b) => b.revenue - a.revenue).slice(0, topN);
        const payload = {
          window: { start: win.startIso, end: win.endIso },
          attribution: attr,
          results: sorted.map((r) => ({
            id: r.campaign.id,
            name: r.campaign.properties?.hs_name,
            revenue: r.revenue,
          })),
        };

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(payload, null, 2)), payload);
        }

        const md = [
          `## Top ${topN} campaigns by ${attr} revenue`,
          `_${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)}_`,
          '',
          `| rank | id | name | revenue |`,
          `| ---: | --- | --- | ---: |`,
          ...sorted.map((r, i) =>
            `| ${i + 1} | ${r.campaign.id} | ${(r.campaign.properties?.hs_name ?? '—')} | ${fmtMoney(r.revenue)} |`,
          ),
        ].join('\n');
        return toolResult(truncate(md), payload);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
