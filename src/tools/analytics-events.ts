/**
 * Phase 4 — Behavioral Events & Sequences.
 *
 *   - hubspot_list_event_types     → GET /events/v3/event-definitions
 *   - hubspot_query_events         → GET /events/v3/events
 *   - hubspot_list_sequences       → GET /automation/v4/sequences
 *   - hubspot_get_sequence_stats   → aggregate from /automation/v4/sequences/enrollments
 *
 * Behavioral events require Marketing Hub Enterprise + the
 * `behavioral_events.event_definitions.read_write` scope.
 *
 * Sales sequences require Sales Hub Enterprise. The Sequences APIs are
 * comparatively young — if endpoints return 404 or 401, the tool's error
 * message will surface that clearly.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hubspotRequest } from '../services/hubspot-client.js';
import { truncate } from '../services/formatters.js';
import { toolError, toolResult } from './_helpers.js';
import { After, Limit, ResponseFormat, TimeWindow, resolveTimeWindow, pct } from '../schemas/common.js';
import type {
  CollectionResponse,
  HubSpotEvent,
  HubSpotEventDefinition,
  HubSpotSequence,
} from '../types.js';

function fmtNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

export function registerEventAnalyticsTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // hubspot_list_event_types
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_list_event_types',
    {
      title: 'List custom event definitions',
      description:
        'Enumerate the custom behavioral event definitions in your HubSpot portal — name, label, ' +
        'primary CRM object, and properties. Use the `name` of an event with `hubspot_query_events` ' +
        'to filter occurrences. Marketing Hub Enterprise + `behavioral_events.event_definitions.read_write` scope required.',
      inputSchema: {
        searchQuery: z.string().optional().describe('Substring filter on event name/label.'),
        archived: z.boolean().optional().describe('Include archived definitions (default: false).'),
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const response = await hubspotRequest<CollectionResponse<HubSpotEventDefinition>>({
          path: '/events/v3/event-definitions',
          query: {
            searchString: args.searchQuery,
            includeArchived: args.archived,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        if (response.results.length === 0) return toolResult('## Event types\n\n_No results._');

        const lines = [
          `## Custom event types (${response.results.length})`,
          '',
          `| name | label | primary object | props |`,
          `| --- | --- | --- | ---: |`,
          ...response.results.map(
            (e) =>
              `| \`${e.name}\` | ${e.label ?? '—'} | ${e.primaryObject ?? '—'} | ${e.properties?.length ?? 0} |`,
          ),
        ];
        return toolResult(truncate(lines.join('\n')), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_query_events
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_query_events',
    {
      title: 'Query custom event occurrences',
      description:
        'Pull occurrences of a custom behavioral event over a time window. Filter by `eventType` ' +
        '(name from `hubspot_list_event_types`), and optionally restrict to a single contact or ' +
        'object. Defaults to last 30 days.',
      inputSchema: {
        eventType: z
          .string()
          .min(1)
          .describe('Event definition name (e.g. `pe123_pricing_page_viewed`).'),
        objectType: z
          .string()
          .optional()
          .describe('Object type filter, typically `contact`.'),
        objectId: z.string().optional().describe('Restrict to a single object ID.'),
        ...TimeWindow,
        limit: Limit,
        after: After,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const win = resolveTimeWindow({ start: args.start, end: args.end });
        const response = await hubspotRequest<{
          results: HubSpotEvent[];
          paging?: { next?: { after?: string } };
        }>({
          path: '/events/v3/events',
          query: {
            eventType: args.eventType,
            objectType: args.objectType,
            objectId: args.objectId,
            occurredAfter: win.startIso,
            occurredBefore: win.endIso,
            limit: args.limit ?? 50,
            after: args.after,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        if (response.results.length === 0) {
          return toolResult(
            `## Events — \`${args.eventType}\`\n\n_No occurrences in window ${win.startIso.slice(0, 10)} → ${win.endIso.slice(0, 10)}._`,
            response,
          );
        }

        const lines = [
          `## Events — \`${args.eventType}\``,
          `_${response.results.length} occurrence(s) in window ${win.startIso.slice(0, 10)} → ${win.endIso.slice(0, 10)}_`,
          '',
        ];
        for (const ev of response.results.slice(0, 50)) {
          lines.push(
            `- ${ev.occurredAt ?? '—'} · ${ev.objectType ?? '—'}:${ev.objectId ?? '—'}` +
              (ev.properties && Object.keys(ev.properties).length > 0
                ? ` · ${Object.entries(ev.properties).slice(0, 5).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(', ')}`
                : ''),
          );
        }
        const cursor = response.paging?.next?.after;
        if (cursor) lines.push('', `_Next cursor: \`${cursor}\`_`);
        return toolResult(truncate(lines.join('\n')), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_list_sequences
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_list_sequences',
    {
      title: 'List sales sequences',
      description:
        'List Sales Hub sequences. Returns id, name, enrolled-contact count, owner, and timestamps. ' +
        'Sequences are exposed via /automation/v4/sequences; if your portal doesn\'t expose this ' +
        'endpoint (older Sales Hub plans), the tool returns the API error verbatim.',
      inputSchema: {
        limit: Limit,
        after: After,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const response = await hubspotRequest<CollectionResponse<HubSpotSequence>>({
          path: '/automation/v4/sequences',
          query: {
            limit: args.limit,
            after: args.after,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        if (response.results.length === 0) return toolResult('## Sequences\n\n_No results._');

        const md = [
          '## Sequences',
          '',
          `_${response.results.length} result(s)._`,
          '',
          `| id | name | enrolled | created |`,
          `| --- | --- | ---: | --- |`,
          ...response.results.map(
            (s) =>
              `| ${s.id} | ${(s.name ?? '—').replace(/\|/g, '\\|')} | ${fmtNum(s.enrolledContactsCount)} | ${s.createdAt ?? '—'} |`,
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
  // hubspot_get_sequence_stats
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_sequence_stats',
    {
      title: 'Sequence enrollment stats',
      description:
        'Pull enrollment counts and outcomes (active, finished, paused, replied, meeting-booked) ' +
        'for one sequence. If your portal exposes the v4 enrollments endpoint, returns aggregated ' +
        'counts; otherwise returns the API error so you know what scope/plan to upgrade.',
      inputSchema: {
        sequenceId: z.string().min(1).describe('The sequence ID.'),
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        // The async-compatible enrollments endpoint. Field shape varies by portal,
        // so we just count states in whatever the API returns.
        const response = await hubspotRequest<{
          results?: Array<{ id: string; state?: string; status?: string; result?: string }>;
          paging?: { next?: { after?: string } };
        }>({
          path: '/automation/v4/sequences/enrollments',
          query: { sequenceId: args.sequenceId, limit: 100 },
        });

        const counts = new Map<string, number>();
        let total = 0;
        for (const r of response.results ?? []) {
          const key = String(r.state ?? r.status ?? r.result ?? 'UNKNOWN');
          counts.set(key, (counts.get(key) ?? 0) + 1);
          total++;
        }
        const repliedKeys = ['REPLIED', 'REPLY', 'PAUSED_REPLY'];
        const meetingKeys = ['MEETING_BOOKED', 'MEETING'];
        const replied = repliedKeys.reduce((s, k) => s + (counts.get(k) ?? 0), 0);
        const meetings = meetingKeys.reduce((s, k) => s + (counts.get(k) ?? 0), 0);

        const payload = {
          sequenceId: args.sequenceId,
          totalSampled: total,
          countsByState: Object.fromEntries(counts),
          replyRate: total > 0 ? replied / total : 0,
          meetingRate: total > 0 ? meetings / total : 0,
        };

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(payload, null, 2)), payload);
        }

        const md = [
          `## Sequence stats — \`${args.sequenceId}\``,
          '',
          `- **Sampled enrollments**: ${fmtNum(total)}`,
          `- **Reply rate**: ${pct(payload.replyRate)} (${fmtNum(replied)})`,
          `- **Meeting rate**: ${pct(payload.meetingRate)} (${fmtNum(meetings)})`,
          '',
          '### By state',
          ...Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `- **${k}**: ${fmtNum(v)}`),
        ].join('\n');
        return toolResult(truncate(md), payload);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
