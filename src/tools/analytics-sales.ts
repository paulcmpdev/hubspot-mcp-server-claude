/**
 * Phase 1 — Sales & Pipeline Analytics.
 *
 * These tools answer the questions sales leaders actually ask:
 *   - "How much pipeline do we have, by stage?"            → get_pipeline_summary
 *   - "How fast are deals moving?"                          → get_deal_velocity
 *   - "What's our win rate?"                                → get_win_rate
 *   - "What did <rep> do this week?"                        → get_owner_activity
 *   - "What drove this deal — source, first-touch?"         → get_deal_attribution
 *
 * Implementation strategy: aggregate over the existing CRM v3 search APIs.
 * No new HubSpot scopes required beyond what the CRUD tools already use.
 *
 * Hard guarantee: read-only. None of these tools mutate anything.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hubspotRequest, paginate } from '../services/hubspot-client.js';
import { truncate } from '../services/formatters.js';
import { toolError, toolResult } from './_helpers.js';
import { ResponseFormat, TimeWindow, resolveTimeWindow, pct } from '../schemas/common.js';
import type { CollectionResponse, HubSpotObject, Pipeline } from '../types.js';

// Used everywhere — fallback pipeline ID is "default" for deals.
const DEFAULT_PIPELINE = 'default';

function fmtMoney(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

function fmtDays(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  return `${(ms / 86_400_000).toFixed(1)} days`;
}

export function registerSalesAnalyticsTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // hubspot_get_pipeline_summary
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_pipeline_summary',
    {
      title: 'Pipeline summary by stage',
      description:
        'Roll up open deals by stage for a given pipeline: count, total amount, weighted amount ' +
        '(amount × stage probability). Closed-won and closed-lost stages are reported separately. ' +
        'Defaults to the "default" deals pipeline; pass `pipelineId` to target another pipeline.',
      inputSchema: {
        pipelineId: z
          .string()
          .optional()
          .describe('Pipeline ID. Defaults to "default" (the standard sales pipeline).'),
        ownerId: z.string().optional().describe('Restrict to deals owned by this owner.'),
        createdSince: z
          .string()
          .optional()
          .describe('Only include deals created at/after this ISO date (e.g. "2026-01-01").'),
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const pipelineId = args.pipelineId ?? DEFAULT_PIPELINE;
        const pipeline = await hubspotRequest<Pipeline>({
          path: `/crm/v3/pipelines/deals/${encodeURIComponent(pipelineId)}`,
        });

        // Build base filter for active-stage queries.
        const baseFilters: Array<{ propertyName: string; operator: string; value?: string }> = [
          { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
        ];
        if (args.ownerId) {
          baseFilters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: args.ownerId });
        }
        if (args.createdSince) {
          const ms = Date.parse(args.createdSince);
          if (!Number.isNaN(ms)) {
            baseFilters.push({ propertyName: 'createdate', operator: 'GTE', value: String(ms) });
          }
        }

        // Aggregate per stage.
        const stages = pipeline.stages.sort((a, b) => a.displayOrder - b.displayOrder);
        const rows: Array<{
          stageId: string;
          stageLabel: string;
          isClosed: boolean;
          probability: number;
          dealCount: number;
          totalAmount: number;
          weightedAmount: number;
        }> = [];

        for (const stage of stages) {
          if (stage.archived) continue;
          const filters = [
            ...baseFilters,
            { propertyName: 'dealstage', operator: 'EQ', value: stage.id },
          ];
          // Pull all deals at this stage. We only need amount.
          const deals = await paginate<HubSpotObject>({
            path: '/crm/v3/objects/deals/search',
            method: 'POST',
            body: {
              filterGroups: [{ filters }],
              properties: ['amount', 'dealstage'],
            },
            pageSize: 100,
            maxPages: 20,
          });
          const probability = Number(stage.metadata?.probability ?? 0) || 0;
          const isClosed =
            stage.metadata?.isClosed === true ||
            stage.metadata?.isClosed === 'true';
          let total = 0;
          for (const d of deals) {
            const v = Number(d.properties?.amount ?? 0);
            if (Number.isFinite(v)) total += v;
          }
          rows.push({
            stageId: stage.id,
            stageLabel: stage.label,
            isClosed,
            probability,
            dealCount: deals.length,
            totalAmount: total,
            weightedAmount: total * probability,
          });
        }

        const openRows = rows.filter((r) => !r.isClosed);
        const closedRows = rows.filter((r) => r.isClosed);
        const totals = {
          openCount: openRows.reduce((s, r) => s + r.dealCount, 0),
          openAmount: openRows.reduce((s, r) => s + r.totalAmount, 0),
          weightedAmount: openRows.reduce((s, r) => s + r.weightedAmount, 0),
          closedCount: closedRows.reduce((s, r) => s + r.dealCount, 0),
          closedAmount: closedRows.reduce((s, r) => s + r.totalAmount, 0),
        };

        const payload = { pipelineId, pipelineLabel: pipeline.label, rows, totals };

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(payload, null, 2)), payload);
        }

        const md = [
          `## Pipeline summary — \`${pipeline.label}\``,
          '',
          `| Stage | Closed? | Prob | Deals | Total | Weighted |`,
          `| --- | --- | --- | ---: | ---: | ---: |`,
          ...rows.map(
            (r) =>
              `| ${r.stageLabel} | ${r.isClosed ? '✓' : ''} | ${pct(r.probability)} | ${fmtNum(
                r.dealCount,
              )} | ${fmtMoney(r.totalAmount)} | ${fmtMoney(r.weightedAmount)} |`,
          ),
          '',
          '### Totals',
          `- **Open deals**: ${fmtNum(totals.openCount)} totaling ${fmtMoney(totals.openAmount)} (weighted: ${fmtMoney(totals.weightedAmount)})`,
          `- **Closed deals**: ${fmtNum(totals.closedCount)} totaling ${fmtMoney(totals.closedAmount)}`,
        ].join('\n');
        return toolResult(truncate(md), payload);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_deal_velocity
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_deal_velocity',
    {
      title: 'Deal velocity (time-to-close)',
      description:
        'For deals that closed (won OR lost) within the time window, compute average and median ' +
        'days from `createdate` to `closedate`. Optionally restrict to a single pipeline or owner. ' +
        'Use this to track if your sales cycle is speeding up or slowing down.',
      inputSchema: {
        pipelineId: z.string().optional().describe('Pipeline ID. Default: all pipelines.'),
        ownerId: z.string().optional().describe('Restrict to deals owned by this owner.'),
        wonOnly: z.boolean().optional().describe('Only count won deals (default: won + lost).'),
        ...TimeWindow,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const win = resolveTimeWindow({ start: args.start, end: args.end });
        const filters: Array<{ propertyName: string; operator: string; value: string }> = [
          { propertyName: 'closedate', operator: 'GTE', value: String(win.startMs) },
          { propertyName: 'closedate', operator: 'LTE', value: String(win.endMs) },
        ];
        if (args.pipelineId) filters.push({ propertyName: 'pipeline', operator: 'EQ', value: args.pipelineId });
        if (args.ownerId) filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: args.ownerId });
        // Restrict to closed stages by hs_is_closed if available, otherwise we'll filter post-hoc by hs_is_closed_won.
        // Simpler: include both won and lost via hs_is_closed=true filter.
        filters.push({ propertyName: 'hs_is_closed', operator: 'EQ', value: 'true' });
        if (args.wonOnly) {
          filters.push({ propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' });
        }

        const deals = await paginate<HubSpotObject>({
          path: '/crm/v3/objects/deals/search',
          method: 'POST',
          body: {
            filterGroups: [{ filters }],
            properties: ['createdate', 'closedate', 'hs_is_closed_won', 'amount'],
          },
          pageSize: 100,
          maxPages: 50,
        });

        const durations: number[] = [];
        let won = 0;
        let lost = 0;
        let totalWonValue = 0;
        for (const d of deals) {
          const created = Date.parse(String(d.properties?.createdate ?? ''));
          const closed = Date.parse(String(d.properties?.closedate ?? ''));
          if (Number.isNaN(created) || Number.isNaN(closed) || closed < created) continue;
          durations.push(closed - created);
          const isWon = String(d.properties?.hs_is_closed_won ?? '') === 'true';
          if (isWon) {
            won++;
            const amt = Number(d.properties?.amount ?? 0);
            if (Number.isFinite(amt)) totalWonValue += amt;
          } else {
            lost++;
          }
        }

        durations.sort((a, b) => a - b);
        const avg = durations.length ? durations.reduce((s, x) => s + x, 0) / durations.length : NaN;
        const median = durations.length
          ? durations[Math.floor(durations.length / 2)]!
          : NaN;
        const p90 = durations.length
          ? durations[Math.floor(durations.length * 0.9)]!
          : NaN;

        const payload = {
          window: { start: win.startIso, end: win.endIso },
          dealCount: deals.length,
          won,
          lost,
          totalWonValue,
          avgDaysToClose: Number.isFinite(avg) ? avg / 86_400_000 : null,
          medianDaysToClose: Number.isFinite(median) ? median / 86_400_000 : null,
          p90DaysToClose: Number.isFinite(p90) ? p90 / 86_400_000 : null,
        };

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(payload, null, 2)), payload);
        }

        const md = [
          `## Deal velocity — ${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)}`,
          '',
          `- **Closed deals**: ${fmtNum(deals.length)} (${fmtNum(won)} won, ${fmtNum(lost)} lost)`,
          `- **Total won value**: ${fmtMoney(totalWonValue)}`,
          `- **Avg time to close**: ${fmtDays(avg)}`,
          `- **Median**: ${fmtDays(median)}`,
          `- **P90**: ${fmtDays(p90)}`,
        ].join('\n');
        return toolResult(truncate(md), payload);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_win_rate
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_win_rate',
    {
      title: 'Win rate over a time window',
      description:
        'Calculate win rate = won / (won + lost) for deals that closed within the window. ' +
        'Optional `groupBy` segments the output by a deal property (e.g. "hubspot_owner_id", ' +
        '"deal_source", "pipeline") so you can see who/what is winning vs. losing.',
      inputSchema: {
        pipelineId: z.string().optional().describe('Pipeline ID. Default: all pipelines.'),
        groupBy: z
          .string()
          .optional()
          .describe(
            'Group results by this deal property (e.g. "hubspot_owner_id", "deal_source", "pipeline").',
          ),
        ...TimeWindow,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const win = resolveTimeWindow({ start: args.start, end: args.end });
        const filters: Array<{ propertyName: string; operator: string; value: string }> = [
          { propertyName: 'closedate', operator: 'GTE', value: String(win.startMs) },
          { propertyName: 'closedate', operator: 'LTE', value: String(win.endMs) },
          { propertyName: 'hs_is_closed', operator: 'EQ', value: 'true' },
        ];
        if (args.pipelineId) filters.push({ propertyName: 'pipeline', operator: 'EQ', value: args.pipelineId });

        const properties = ['hs_is_closed_won', 'amount'];
        if (args.groupBy) properties.push(args.groupBy);

        const deals = await paginate<HubSpotObject>({
          path: '/crm/v3/objects/deals/search',
          method: 'POST',
          body: { filterGroups: [{ filters }], properties },
          pageSize: 100,
          maxPages: 50,
        });

        type Bucket = { won: number; lost: number; wonValue: number; lostValue: number };
        const allBucket: Bucket = { won: 0, lost: 0, wonValue: 0, lostValue: 0 };
        const groups = new Map<string, Bucket>();

        for (const d of deals) {
          const isWon = String(d.properties?.hs_is_closed_won ?? '') === 'true';
          const amt = Number(d.properties?.amount ?? 0);
          if (isWon) {
            allBucket.won++;
            if (Number.isFinite(amt)) allBucket.wonValue += amt;
          } else {
            allBucket.lost++;
            if (Number.isFinite(amt)) allBucket.lostValue += amt;
          }
          if (args.groupBy) {
            const key = String(d.properties?.[args.groupBy] ?? '(unset)');
            const b = groups.get(key) ?? { won: 0, lost: 0, wonValue: 0, lostValue: 0 };
            if (isWon) {
              b.won++;
              if (Number.isFinite(amt)) b.wonValue += amt;
            } else {
              b.lost++;
              if (Number.isFinite(amt)) b.lostValue += amt;
            }
            groups.set(key, b);
          }
        }

        const overall = {
          won: allBucket.won,
          lost: allBucket.lost,
          total: allBucket.won + allBucket.lost,
          winRate: allBucket.won + allBucket.lost > 0 ? allBucket.won / (allBucket.won + allBucket.lost) : 0,
          wonValue: allBucket.wonValue,
          lostValue: allBucket.lostValue,
        };

        const groupRows = args.groupBy
          ? Array.from(groups.entries())
              .map(([key, b]) => ({
                key,
                won: b.won,
                lost: b.lost,
                total: b.won + b.lost,
                winRate: b.won + b.lost > 0 ? b.won / (b.won + b.lost) : 0,
                wonValue: b.wonValue,
                lostValue: b.lostValue,
              }))
              .sort((a, b) => b.total - a.total)
          : null;

        const payload = {
          window: { start: win.startIso, end: win.endIso },
          overall,
          groupBy: args.groupBy ?? null,
          groups: groupRows,
        };

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(payload, null, 2)), payload);
        }

        const lines = [
          `## Win rate — ${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)}`,
          '',
          `- **Overall**: ${pct(overall.winRate)} (${fmtNum(overall.won)} won / ${fmtNum(overall.total)} closed)`,
          `- **Won value**: ${fmtMoney(overall.wonValue)}`,
          `- **Lost value**: ${fmtMoney(overall.lostValue)}`,
        ];
        if (groupRows && groupRows.length > 0) {
          lines.push(
            '',
            `### By \`${args.groupBy}\``,
            '',
            `| ${args.groupBy} | Won | Lost | Total | Win rate | Won value |`,
            `| --- | ---: | ---: | ---: | ---: | ---: |`,
            ...groupRows.map(
              (r) =>
                `| ${r.key} | ${fmtNum(r.won)} | ${fmtNum(r.lost)} | ${fmtNum(r.total)} | ${pct(r.winRate)} | ${fmtMoney(r.wonValue)} |`,
            ),
          );
        }
        return toolResult(truncate(lines.join('\n')), payload);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_owner_activity
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_owner_activity',
    {
      title: 'Owner activity (calls/emails/meetings/notes/tasks logged)',
      description:
        'Count engagements (calls, emails, meetings, notes, tasks) logged by an owner — or all ' +
        'owners — within the time window. Driven by `hs_timestamp` and `hubspot_owner_id` on each ' +
        'engagement object. Use to size rep effort, spot quiet weeks, or compare activity across the team.',
      inputSchema: {
        ownerId: z.string().optional().describe('Restrict to a single owner. If omitted, totals across all owners.'),
        ...TimeWindow,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const win = resolveTimeWindow({ start: args.start, end: args.end });
        const types = ['calls', 'emails', 'meetings', 'notes', 'tasks'] as const;

        const baseFilters: Array<{ propertyName: string; operator: string; value: string }> = [
          { propertyName: 'hs_timestamp', operator: 'GTE', value: String(win.startMs) },
          { propertyName: 'hs_timestamp', operator: 'LTE', value: String(win.endMs) },
        ];
        if (args.ownerId) {
          baseFilters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: args.ownerId });
        }

        const counts: Record<string, number> = {};
        for (const t of types) {
          const all = await paginate<HubSpotObject>({
            path: `/crm/v3/objects/${t}/search`,
            method: 'POST',
            body: {
              filterGroups: [{ filters: baseFilters }],
              properties: ['hubspot_owner_id'],
            },
            pageSize: 100,
            maxPages: 100,
          });
          counts[t] = all.length;
        }
        const total = Object.values(counts).reduce((s, x) => s + x, 0);

        const payload = {
          window: { start: win.startIso, end: win.endIso },
          ownerId: args.ownerId ?? null,
          counts,
          total,
        };

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(payload, null, 2)), payload);
        }

        const md = [
          `## Activity — ${args.ownerId ? `owner \`${args.ownerId}\`` : 'all owners'}`,
          `_${win.startIso.slice(0, 10)} to ${win.endIso.slice(0, 10)}_`,
          '',
          ...types.map((t) => `- **${t}**: ${fmtNum(counts[t])}`),
          '',
          `**Total**: ${fmtNum(total)}`,
        ].join('\n');
        return toolResult(truncate(md), payload);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_deal_attribution
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_deal_attribution',
    {
      title: 'Deal attribution (source, first/last touch)',
      description:
        'Pull the analytics-attribution properties on a single deal — original source, first/last ' +
        'referrer, originating campaign — to answer "what brought this deal in?". Combines deal-level ' +
        'attribution and the primary contact\'s attribution if the deal has an associated contact.',
      inputSchema: {
        dealId: z.string().min(1).describe('The HubSpot deal ID.'),
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const dealProperties = [
          'dealname',
          'amount',
          'closedate',
          'dealstage',
          'pipeline',
          'hubspot_owner_id',
          'hs_analytics_source',
          'hs_analytics_source_data_1',
          'hs_analytics_source_data_2',
          'hs_analytics_first_touch_converting_campaign',
          'hs_analytics_last_touch_converting_campaign',
          'hs_campaign',
          'deal_source',
        ];
        const deal = await hubspotRequest<HubSpotObject>({
          path: `/crm/v3/objects/deals/${encodeURIComponent(args.dealId)}`,
          query: { properties: dealProperties.join(','), associations: 'contacts' },
        });

        let contact: HubSpotObject | null = null;
        const contactId = deal.associations?.contacts?.results?.[0]?.id;
        if (contactId) {
          contact = await hubspotRequest<HubSpotObject>({
            path: `/crm/v3/objects/contacts/${contactId}`,
            query: {
              properties: [
                'firstname',
                'lastname',
                'email',
                'hs_analytics_source',
                'hs_analytics_source_data_1',
                'hs_analytics_first_referrer',
                'hs_analytics_last_referrer',
                'hs_analytics_first_url',
                'hs_analytics_last_url',
                'hs_analytics_first_visit_timestamp',
                'hs_analytics_first_touch_converting_campaign',
                'hs_analytics_last_touch_converting_campaign',
              ].join(','),
            },
          });
        }

        const payload = { deal, contact };

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(payload, null, 2)), payload);
        }

        const dp = deal.properties ?? {};
        const cp = contact?.properties ?? {};
        const md = [
          `## Deal attribution — \`${dp.dealname ?? args.dealId}\``,
          '',
          '### Deal-level',
          `- **amount**: ${fmtMoney(Number(dp.amount))}`,
          `- **stage**: ${dp.dealstage ?? '—'}`,
          `- **owner**: ${dp.hubspot_owner_id ?? '—'}`,
          `- **deal_source**: ${dp.deal_source ?? '—'}`,
          `- **hs_analytics_source**: ${dp.hs_analytics_source ?? '—'}`,
          `- **source detail**: ${dp.hs_analytics_source_data_1 ?? '—'} / ${dp.hs_analytics_source_data_2 ?? '—'}`,
          `- **first-touch campaign**: ${dp.hs_analytics_first_touch_converting_campaign ?? '—'}`,
          `- **last-touch campaign**: ${dp.hs_analytics_last_touch_converting_campaign ?? '—'}`,
          '',
          contact
            ? [
                `### Primary contact (\`${cp.email ?? contact.id}\`)`,
                `- **first source**: ${cp.hs_analytics_source ?? '—'} (${cp.hs_analytics_source_data_1 ?? '—'})`,
                `- **first referrer**: ${cp.hs_analytics_first_referrer ?? '—'}`,
                `- **last referrer**: ${cp.hs_analytics_last_referrer ?? '—'}`,
                `- **first URL**: ${cp.hs_analytics_first_url ?? '—'}`,
                `- **first visit**: ${cp.hs_analytics_first_visit_timestamp ?? '—'}`,
                `- **first-touch campaign**: ${cp.hs_analytics_first_touch_converting_campaign ?? '—'}`,
                `- **last-touch campaign**: ${cp.hs_analytics_last_touch_converting_campaign ?? '—'}`,
              ].join('\n')
            : '_No primary contact associated with this deal._',
        ].join('\n');
        return toolResult(truncate(md), payload);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
