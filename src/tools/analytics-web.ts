/**
 * Phase 3 — Forms & Web Analytics.
 *
 *   - hubspot_list_forms              → GET /marketing/v3/forms
 *   - hubspot_get_form_submissions    → GET /form-integrations/v1/submissions/forms/{formGuid}
 *   - hubspot_get_traffic_summary     → GET /analytics/v2/reports/sources/{timePeriod}
 *   - hubspot_get_top_pages           → GET /analytics/v2/reports/pages/{timePeriod}
 *
 * Forms require the `forms` scope. Web analytics endpoints are the v2 legacy
 * surface — they're still functional on Enterprise and the Operations Hub.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hubspotRequest } from '../services/hubspot-client.js';
import { truncate } from '../services/formatters.js';
import { toolError, toolResult } from './_helpers.js';
import { After, Limit, ResponseFormat, TimeWindow, resolveTimeWindow } from '../schemas/common.js';
import type {
  AnalyticsBucket,
  CollectionResponse,
  HubSpotForm,
  HubSpotFormSubmission,
} from '../types.js';

function fmtNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

const TIME_PERIOD = z
  .enum(['total', 'summarize/daily', 'summarize/weekly', 'summarize/monthly', 'daily', 'weekly', 'monthly'])
  .optional()
  .describe(
    'Aggregation granularity. `total` (default) returns one bucket; the others bucket over time.',
  );

export function registerWebAnalyticsTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // hubspot_list_forms
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_list_forms',
    {
      title: 'List marketing forms',
      description:
        'List forms from /marketing/v3/forms. Filter by `formType` (HUBSPOT, CAPTURED, FLOW, etc.) ' +
        'or `archived`. Use `hubspot_get_form_submissions` to pull responses for one form. ' +
        'Requires the `forms` scope.',
      inputSchema: {
        formType: z.string().optional().describe('Form type filter, e.g. `HUBSPOT`.'),
        archived: z.boolean().optional().describe('Include archived forms (default: false).'),
        limit: Limit,
        after: After,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const response = await hubspotRequest<CollectionResponse<HubSpotForm>>({
          path: '/marketing/v3/forms',
          query: {
            formTypes: args.formType,
            archived: args.archived,
            limit: args.limit,
            after: args.after,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        if (response.results.length === 0) return toolResult('## Forms\n\n_No results._');

        const md = [
          '## Forms',
          '',
          `_${response.results.length} result(s)._`,
          '',
          `| id | name | type | archived |`,
          `| --- | --- | --- | --- |`,
          ...response.results.map(
            (f) =>
              `| ${f.id} | ${(f.name ?? '—').replace(/\|/g, '\\|')} | ${f.formType ?? '—'} | ${f.archived ? '✓' : ''} |`,
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
  // hubspot_get_form_submissions
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_form_submissions',
    {
      title: 'Get form submissions',
      description:
        'Fetch submissions for one form by GUID. Returns the submitted field values, the page ' +
        'URL/title that hosted the form, and the submission timestamp. Paginated via `after`.',
      inputSchema: {
        formGuid: z.string().min(1).describe('The form GUID (matches the form `id`).'),
        limit: Limit,
        after: After,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const response = await hubspotRequest<{
          results: HubSpotFormSubmission[];
          paging?: { next?: { after?: string } };
        }>({
          path: `/form-integrations/v1/submissions/forms/${encodeURIComponent(args.formGuid)}`,
          query: {
            limit: args.limit ?? 50,
            after: args.after,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        if (response.results.length === 0) return toolResult('## Form submissions\n\n_No results._');

        const lines: string[] = [
          `## Form submissions — \`${args.formGuid}\``,
          '',
          `_${response.results.length} submission(s)._`,
          '',
        ];
        for (const s of response.results) {
          const when = s.submittedAt ? new Date(s.submittedAt).toISOString() : '—';
          lines.push(`### ${when}`);
          if (s.pageUrl) lines.push(`- **page**: ${s.pageTitle ?? ''} ${s.pageUrl}`);
          if (s.values && s.values.length > 0) {
            for (const v of s.values) {
              lines.push(`  - **${v.name}**: ${v.value}`);
            }
          }
          lines.push('');
        }
        const cursor = response.paging?.next?.after;
        if (cursor) lines.push(`_Next cursor: \`${cursor}\`_`);
        return toolResult(truncate(lines.join('\n')), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_traffic_summary
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_traffic_summary',
    {
      title: 'Web traffic by source',
      description:
        'Sessions, contacts, and bounces broken down by traffic source ' +
        '(direct, organic search, referral, social, email, paid, other). Defaults to last 30 days.',
      inputSchema: {
        timePeriod: TIME_PERIOD,
        ...TimeWindow,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const win = resolveTimeWindow({ start: args.start, end: args.end });
        const period = args.timePeriod ?? 'total';
        const response = await hubspotRequest<{
          breakdowns?: AnalyticsBucket[];
          total?: AnalyticsBucket;
          [key: string]: unknown;
        }>({
          path: `/analytics/v2/reports/sources/${period}`,
          query: { start: win.startIso.slice(0, 10), end: win.endIso.slice(0, 10) },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        // The v2 API can return either { breakdowns: [...] } or { <date>: [...] } depending on period.
        // We normalize to a flat list for display.
        let buckets: AnalyticsBucket[] = [];
        if (Array.isArray(response.breakdowns)) {
          buckets = response.breakdowns;
        } else {
          for (const v of Object.values(response)) {
            if (Array.isArray(v)) buckets.push(...(v as AnalyticsBucket[]));
          }
        }

        if (buckets.length === 0) {
          return toolResult(
            `## Traffic by source — ${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)}\n\n_No data._`,
            response,
          );
        }

        const md = [
          `## Traffic by source — ${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)} (${period})`,
          '',
          `| breakdown | sessions | visitors | pageviews | contacts |`,
          `| --- | ---: | ---: | ---: | ---: |`,
          ...buckets.map(
            (b) =>
              `| ${b.breakdown ?? '(unknown)'} | ${fmtNum(b.visits)} | ${fmtNum(b.visitors)} | ${fmtNum(b.pageviews ?? b.rawViews)} | ${fmtNum(b.contactsConverted)} |`,
          ),
        ].join('\n');
        return toolResult(truncate(md), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_top_pages
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_top_pages',
    {
      title: 'Top pages by views',
      description:
        'Top pages on your site/blog by views over a time window. Returns URL, page title, ' +
        'pageviews, entrances, exits, and bounce rate. Defaults to last 30 days.',
      inputSchema: {
        timePeriod: TIME_PERIOD,
        limit: Limit,
        ...TimeWindow,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const win = resolveTimeWindow({ start: args.start, end: args.end });
        const period = args.timePeriod ?? 'total';
        const response = await hubspotRequest<{
          breakdowns?: AnalyticsBucket[];
          [key: string]: unknown;
        }>({
          path: `/analytics/v2/reports/pages/${period}`,
          query: {
            start: win.startIso.slice(0, 10),
            end: win.endIso.slice(0, 10),
            limit: args.limit ?? 25,
            sort: 'pageviews',
            order: 'DESC',
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        let buckets: AnalyticsBucket[] = [];
        if (Array.isArray(response.breakdowns)) {
          buckets = response.breakdowns;
        } else {
          for (const v of Object.values(response)) {
            if (Array.isArray(v)) buckets.push(...(v as AnalyticsBucket[]));
          }
        }

        if (buckets.length === 0) {
          return toolResult(
            `## Top pages — ${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)}\n\n_No data._`,
            response,
          );
        }

        const md = [
          `## Top pages — ${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)}`,
          '',
          `| page | pageviews | visitors | bounces |`,
          `| --- | ---: | ---: | ---: |`,
          ...buckets.map(
            (b) =>
              `| ${(b.breakdown ?? '(unknown)').replace(/\|/g, '\\|')} | ${fmtNum(b.pageviews ?? b.rawViews)} | ${fmtNum(b.visitors)} | ${fmtNum(b.bounces)} |`,
          ),
        ].join('\n');
        return toolResult(truncate(md), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
