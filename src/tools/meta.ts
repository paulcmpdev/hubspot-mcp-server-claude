/**
 * Meta tools:
 *   - hubspot_describe_object: introspect property definitions for any object
 *     type. The single most useful tool for letting an LLM make smart
 *     decisions about which properties to read/write.
 *   - hubspot_list_owners: enumerate users that can be assigned to records.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hubspotRequest } from '../services/hubspot-client.js';
import { formatOwner, formatProperty, truncate } from '../services/formatters.js';
import { toolError, toolResult } from './_helpers.js';
import { ResponseFormat, Limit, After } from '../schemas/common.js';
import type {
  CollectionResponse,
  HubSpotOwner,
  HubSpotPropertiesResponse,
} from '../types.js';

const SUPPORTED_OBJECT_TYPES = [
  'contacts',
  'companies',
  'deals',
  'tickets',
  'tasks',
  'calls',
  'meetings',
  'notes',
  'emails',
  'line_items',
  'products',
  'quotes',
] as const;

export function registerMetaTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // hubspot_describe_object
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_describe_object',
    {
      title: 'Describe object schema',
      description:
        'List all property definitions for a HubSpot object type ' +
        '(contacts, companies, deals, tasks, calls, meetings, notes, emails, ' +
        'tickets, line_items, products, quotes). ' +
        'Returns each property\'s name, label, type, options, and metadata. ' +
        'Use this BEFORE create/update tools to confirm property names and types.',
      inputSchema: {
        objectType: z.enum(SUPPORTED_OBJECT_TYPES).describe('The CRM object type to describe.'),
        archived: z.boolean().optional().describe('Include archived properties (default: false).'),
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const response = await hubspotRequest<HubSpotPropertiesResponse>({
          path: `/crm/v3/properties/${args.objectType}`,
          query: { archived: args.archived },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        const visible = response.results
          .filter((p) => !p.hidden)
          .sort((a, b) => a.name.localeCompare(b.name));
        const md = [
          `## Properties on \`${args.objectType}\``,
          '',
          `_${visible.length} visible properties (of ${response.results.length} total)._`,
          '',
          ...visible.map(formatProperty),
        ].join('\n\n');
        return toolResult(truncate(md), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_list_owners
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_list_owners',
    {
      title: 'List owners',
      description:
        'List HubSpot owners (users who can be assigned to records via `hubspot_owner_id`). ' +
        'Returns id, email, name, and team membership. Supports pagination via `after`.',
      inputSchema: {
        email: z.string().optional().describe('Optional email filter — exact match.'),
        archived: z.boolean().optional().describe('Include archived owners (default: false).'),
        limit: Limit,
        after: After,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const response = await hubspotRequest<CollectionResponse<HubSpotOwner>>({
          path: '/crm/v3/owners',
          query: {
            email: args.email,
            archived: args.archived,
            limit: args.limit,
            after: args.after,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        const md = [
          '## Owners',
          '',
          `_${response.results.length} owner(s)._`,
          '',
          ...response.results.map((o) => formatOwner(o) + '\n'),
        ].join('\n');
        const cursor = response.paging?.next?.after;
        const footer = cursor ? `\n_Next cursor: \`${cursor}\`_` : '';
        return toolResult(truncate(md + footer), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
