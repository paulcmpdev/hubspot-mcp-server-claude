/**
 * Tool factories — build standard search/get/create/update tools for any
 * CRM object type. This collapses ~4× duplicated boilerplate per object
 * (tasks, contacts, deals, …) into a single declarative spec.
 *
 * Hard guarantee: no factory issues DELETE requests. Only GET, POST, PATCH.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hubspotRequest } from '../services/hubspot-client.js';
import { formatObject, formatObjectList, truncate } from '../services/formatters.js';
import { toolError, toolResult } from './_helpers.js';
import {
  After,
  Associations,
  FilterGroups,
  Limit,
  PropertyBag,
  PropertyList,
  ResponseFormat,
  SearchQuery,
  Sorts,
  stringifyProperties,
} from '../schemas/common.js';
import type { CollectionResponse, HubSpotObject } from '../types.js';
import { DEFAULT_PAGE_SIZE } from '../constants.js';

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

export interface ObjectToolSpec {
  /** Tool-name prefix, e.g. `hubspot_<verb>_tasks`. */
  toolNoun: string; // e.g. 'tasks', 'task'
  /** Pluralized URL path segment for /crm/v3/objects/{path}. */
  apiPath: string;
  /** Human-readable singular noun used in tool descriptions, e.g. 'task'. */
  singular: string;
  /** Human-readable plural noun used in tool descriptions, e.g. 'tasks'. */
  plural: string;
  /** Default properties to fetch on get/search. */
  defaultProperties: string[];
  /** Columns shown in search-result tables. */
  columns: Array<{ property: string; label?: string }>;
  /** Property name treated as the headline for `formatObject` titles. */
  titleProperty?: string;
}

// ---------------------------------------------------------------------------
// Search tool
// ---------------------------------------------------------------------------

export function registerSearchTool(server: McpServer, spec: ObjectToolSpec): void {
  const inputSchema = {
    query: SearchQuery,
    filterGroups: FilterGroups,
    sorts: Sorts,
    properties: PropertyList,
    limit: Limit,
    after: After,
    response_format: ResponseFormat,
  };

  server.registerTool(
    `hubspot_search_${spec.toolNoun}`,
    {
      title: `Search ${spec.plural}`,
      description:
        `Search HubSpot ${spec.plural} via POST /crm/v3/objects/${spec.apiPath}/search. ` +
        `Supports free-text \`query\`, \`filterGroups\` (AND within / OR across), ` +
        `sorting, property selection, and cursor pagination. ` +
        `Use \`hubspot_describe_object\` to discover property names.`,
      inputSchema,
    },
    async (args) => {
      try {
        const properties = args.properties ?? spec.defaultProperties;
        const body = {
          query: args.query,
          filterGroups: args.filterGroups,
          sorts: args.sorts,
          properties,
          limit: args.limit ?? DEFAULT_PAGE_SIZE,
          after: args.after,
        };
        const response = await hubspotRequest<CollectionResponse>({
          path: `/crm/v3/objects/${spec.apiPath}/search`,
          method: 'POST',
          body,
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        const md = formatObjectList(response.results, {
          title: `Search results — ${spec.plural}`,
          columns: spec.columns,
          total: response.total,
        });
        const cursor = response.paging?.next?.after;
        const footer = cursor ? `\n\n_Next cursor: \`${cursor}\`_` : '';
        return toolResult(truncate(md + footer), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Get-by-id tool
// ---------------------------------------------------------------------------

export function registerGetTool(server: McpServer, spec: ObjectToolSpec): void {
  const inputSchema = {
    id: z.string().min(1).describe(`The HubSpot ${spec.singular} ID.`),
    properties: PropertyList,
    associations: z
      .array(z.string().min(1))
      .optional()
      .describe('Associated object types to include (e.g. `["contacts","companies"]`).'),
    response_format: ResponseFormat,
  };

  server.registerTool(
    `hubspot_get_${spec.singular}`,
    {
      title: `Get ${spec.singular} by ID`,
      description: `Fetch a single HubSpot ${spec.singular} by its ID.`,
      inputSchema,
    },
    async (args) => {
      try {
        const properties = (args.properties ?? spec.defaultProperties).join(',');
        const obj = await hubspotRequest<HubSpotObject>({
          path: `/crm/v3/objects/${spec.apiPath}/${encodeURIComponent(args.id)}`,
          query: {
            properties,
            associations: args.associations?.join(','),
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(obj, null, 2)), obj);
        }

        const title = spec.titleProperty
          ? `${spec.singular}: ${obj.properties?.[spec.titleProperty] ?? obj.id}`
          : `${spec.singular} ${obj.id}`;
        return toolResult(truncate(formatObject(obj, { title })), obj);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Create tool
// ---------------------------------------------------------------------------

export function registerCreateTool(server: McpServer, spec: ObjectToolSpec): void {
  const inputSchema = {
    properties: PropertyBag,
    associations: Associations,
    response_format: ResponseFormat,
  };

  server.registerTool(
    `hubspot_create_${spec.singular}`,
    {
      title: `Create ${spec.singular}`,
      description:
        `Create a HubSpot ${spec.singular} via POST /crm/v3/objects/${spec.apiPath}. ` +
        `Use \`hubspot_describe_object\` to discover the property schema. ` +
        `Optional \`associations\` ties the new record to existing contacts/companies/deals/etc.`,
      inputSchema,
    },
    async (args) => {
      try {
        const obj = await hubspotRequest<HubSpotObject>({
          path: `/crm/v3/objects/${spec.apiPath}`,
          method: 'POST',
          body: {
            properties: stringifyProperties(args.properties),
            associations: args.associations,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(obj, null, 2)), obj);
        }
        return toolResult(
          truncate(`Created ${spec.singular} \`${obj.id}\`.\n\n${formatObject(obj, { title: `New ${spec.singular}` })}`),
          obj,
        );
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Update tool (PATCH)
// ---------------------------------------------------------------------------

export function registerUpdateTool(server: McpServer, spec: ObjectToolSpec): void {
  const inputSchema = {
    id: z.string().min(1).describe(`The HubSpot ${spec.singular} ID to update.`),
    properties: PropertyBag,
    response_format: ResponseFormat,
  };

  server.registerTool(
    `hubspot_update_${spec.singular}`,
    {
      title: `Update ${spec.singular}`,
      description:
        `Update a HubSpot ${spec.singular} via PATCH /crm/v3/objects/${spec.apiPath}/{id}. ` +
        `Only provided properties are modified; all others are left untouched. ` +
        `This server never issues DELETE — to remove a value, set the property to an empty string.`,
      inputSchema,
    },
    async (args) => {
      try {
        const obj = await hubspotRequest<HubSpotObject>({
          path: `/crm/v3/objects/${spec.apiPath}/${encodeURIComponent(args.id)}`,
          method: 'PATCH',
          body: {
            properties: stringifyProperties(args.properties),
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(obj, null, 2)), obj);
        }
        return toolResult(
          truncate(`Updated ${spec.singular} \`${obj.id}\`.\n\n${formatObject(obj, { title: `Updated ${spec.singular}` })}`),
          obj,
        );
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
