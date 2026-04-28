/**
 * Contact tools — search, get, create, update.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerCreateTool,
  registerGetTool,
  registerSearchTool,
  registerUpdateTool,
  type ObjectToolSpec,
} from './_factories.js';

const CONTACTS: ObjectToolSpec = {
  toolNoun: 'contacts',
  singular: 'contact',
  plural: 'contacts',
  apiPath: 'contacts',
  defaultProperties: [
    'firstname',
    'lastname',
    'email',
    'phone',
    'company',
    'jobtitle',
    'lifecyclestage',
    'hubspot_owner_id',
    'createdate',
    'lastmodifieddate',
  ],
  columns: [
    { property: 'firstname', label: 'first' },
    { property: 'lastname', label: 'last' },
    { property: 'email', label: 'email' },
    { property: 'company', label: 'company' },
    { property: 'lifecyclestage', label: 'stage' },
  ],
  titleProperty: 'email',
};

export function registerContactTools(server: McpServer): void {
  registerSearchTool(server, CONTACTS);
  registerGetTool(server, CONTACTS);
  registerCreateTool(server, CONTACTS);
  registerUpdateTool(server, CONTACTS);
}
