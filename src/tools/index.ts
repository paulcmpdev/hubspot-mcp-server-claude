/**
 * Aggregate tool registration. Adding a new tool? Register it here.
 *
 * Hard guarantee: this server exposes ONLY read, create, and update operations.
 * No tool issues a DELETE — see services/hubspot-client.ts for the type-level
 * enforcement.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEngagementTools } from './engagements.js';
import { registerContactTools } from './contacts.js';
import { registerCompanyTools } from './companies.js';
import { registerDealTools } from './deals.js';
import { registerLineItemTools } from './line-items.js';
import { registerFileTools } from './files.js';
import { registerMetaTools } from './meta.js';

/** Names of every registered tool. Used for the health-check / logs. */
export const ALL_TOOL_NAMES = [
  // Engagements (the unblocking goal)
  'hubspot_search_tasks',
  'hubspot_get_task',
  'hubspot_create_task',
  'hubspot_update_task',
  'hubspot_search_calls',
  'hubspot_create_call',
  'hubspot_search_meetings',
  'hubspot_create_meeting',
  'hubspot_search_notes',
  'hubspot_create_note',
  'hubspot_search_emails',
  'hubspot_get_email',
  // Contacts
  'hubspot_search_contacts',
  'hubspot_get_contact',
  'hubspot_create_contact',
  'hubspot_update_contact',
  // Companies
  'hubspot_search_companies',
  'hubspot_get_company',
  'hubspot_create_company',
  'hubspot_update_company',
  // Deals
  'hubspot_search_deals',
  'hubspot_get_deal',
  'hubspot_create_deal',
  'hubspot_update_deal',
  // Line items
  'hubspot_search_line_items',
  'hubspot_get_line_item',
  'hubspot_create_line_item',
  'hubspot_update_line_item',
  // Files (File Manager — separate API surface from CRM)
  'hubspot_search_files',
  'hubspot_get_file',
  'hubspot_get_file_signed_url',
  'hubspot_upload_file_from_url',
  // Meta
  'hubspot_describe_object',
  'hubspot_list_owners',
] as const;

export function registerAllTools(server: McpServer): void {
  registerEngagementTools(server);
  registerContactTools(server);
  registerCompanyTools(server);
  registerDealTools(server);
  registerLineItemTools(server);
  registerFileTools(server);
  registerMetaTools(server);
}
