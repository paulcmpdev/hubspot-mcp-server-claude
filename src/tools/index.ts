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
import { registerProductTools } from './products.js';
import { registerFileTools } from './files.js';
import { registerMetaTools } from './meta.js';
import { registerSalesAnalyticsTools } from './analytics-sales.js';
import { registerMarketingAnalyticsTools } from './analytics-marketing.js';
import { registerWebAnalyticsTools } from './analytics-web.js';
import { registerEventAnalyticsTools } from './analytics-events.js';

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
  // Products (catalog used by line items)
  'hubspot_search_products',
  'hubspot_get_product',
  'hubspot_create_product',
  'hubspot_update_product',
  // Files (File Manager — separate API surface from CRM)
  'hubspot_search_files',
  'hubspot_get_file',
  'hubspot_get_file_signed_url',
  'hubspot_upload_file_from_url',
  // Meta
  'hubspot_describe_object',
  'hubspot_list_owners',
  // Analytics — sales & pipeline
  'hubspot_get_pipeline_summary',
  'hubspot_get_deal_velocity',
  'hubspot_get_win_rate',
  'hubspot_get_owner_activity',
  'hubspot_get_deal_attribution',
  // Analytics — email & marketing campaigns
  'hubspot_list_email_campaigns',
  'hubspot_get_email_campaign_stats',
  'hubspot_aggregate_email_stats',
  'hubspot_list_marketing_campaigns',
  'hubspot_get_marketing_campaign_metrics',
  'hubspot_get_top_campaigns_by_revenue',
  // Analytics — forms & web
  'hubspot_list_forms',
  'hubspot_get_form_submissions',
  'hubspot_get_traffic_summary',
  'hubspot_get_top_pages',
  // Analytics — events & sequences
  'hubspot_list_event_types',
  'hubspot_query_events',
  'hubspot_list_sequences',
  'hubspot_get_sequence_stats',
] as const;

export function registerAllTools(server: McpServer): void {
  registerEngagementTools(server);
  registerContactTools(server);
  registerCompanyTools(server);
  registerDealTools(server);
  registerLineItemTools(server);
  registerProductTools(server);
  registerFileTools(server);
  registerMetaTools(server);
  registerSalesAnalyticsTools(server);
  registerMarketingAnalyticsTools(server);
  registerWebAnalyticsTools(server);
  registerEventAnalyticsTools(server);
}
