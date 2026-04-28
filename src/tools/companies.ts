/**
 * Company tools — search, get, create, update.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerCreateTool,
  registerGetTool,
  registerSearchTool,
  registerUpdateTool,
  type ObjectToolSpec,
} from './_factories.js';

const COMPANIES: ObjectToolSpec = {
  toolNoun: 'companies',
  singular: 'company',
  plural: 'companies',
  apiPath: 'companies',
  defaultProperties: [
    'name',
    'domain',
    'industry',
    'phone',
    'city',
    'state',
    'country',
    'numberofemployees',
    'annualrevenue',
    'lifecyclestage',
    'hubspot_owner_id',
  ],
  columns: [
    { property: 'name', label: 'name' },
    { property: 'domain', label: 'domain' },
    { property: 'industry', label: 'industry' },
    { property: 'lifecyclestage', label: 'stage' },
    { property: 'hubspot_owner_id', label: 'owner' },
  ],
  titleProperty: 'name',
};

export function registerCompanyTools(server: McpServer): void {
  registerSearchTool(server, COMPANIES);
  registerGetTool(server, COMPANIES);
  registerCreateTool(server, COMPANIES);
  registerUpdateTool(server, COMPANIES);
}
