/**
 * Deal tools — search, get, create, update.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerCreateTool,
  registerGetTool,
  registerSearchTool,
  registerUpdateTool,
  type ObjectToolSpec,
} from './_factories.js';

const DEALS: ObjectToolSpec = {
  toolNoun: 'deals',
  singular: 'deal',
  plural: 'deals',
  apiPath: 'deals',
  defaultProperties: [
    'dealname',
    'dealstage',
    'pipeline',
    'amount',
    'closedate',
    'dealtype',
    'hubspot_owner_id',
    'createdate',
    'hs_lastmodifieddate',
  ],
  columns: [
    { property: 'dealname', label: 'name' },
    { property: 'dealstage', label: 'stage' },
    { property: 'amount', label: 'amount' },
    { property: 'closedate', label: 'close' },
    { property: 'hubspot_owner_id', label: 'owner' },
  ],
  titleProperty: 'dealname',
};

export function registerDealTools(server: McpServer): void {
  registerSearchTool(server, DEALS);
  registerGetTool(server, DEALS);
  registerCreateTool(server, DEALS);
  registerUpdateTool(server, DEALS);
}
