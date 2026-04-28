/**
 * Line item tools — search, get, create, update.
 *
 * Line items are typically associated with a deal, quote, or invoice. The
 * `associations` argument on `hubspot_create_line_item` is the way to attach
 * a new line item to its parent record at creation time.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerCreateTool,
  registerGetTool,
  registerSearchTool,
  registerUpdateTool,
  type ObjectToolSpec,
} from './_factories.js';

const LINE_ITEMS: ObjectToolSpec = {
  toolNoun: 'line_items',
  singular: 'line_item',
  plural: 'line items',
  apiPath: 'line_items',
  defaultProperties: [
    'name',
    'description',
    'price',
    'quantity',
    'amount',
    'discount',
    'tax',
    'hs_product_id',
    'hs_sku',
    'hs_recurring_billing_period',
    'createdate',
    'hs_lastmodifieddate',
  ],
  columns: [
    { property: 'name', label: 'name' },
    { property: 'quantity', label: 'qty' },
    { property: 'price', label: 'price' },
    { property: 'amount', label: 'amount' },
    { property: 'hs_sku', label: 'sku' },
  ],
  titleProperty: 'name',
};

export function registerLineItemTools(server: McpServer): void {
  registerSearchTool(server, LINE_ITEMS);
  registerGetTool(server, LINE_ITEMS);
  registerCreateTool(server, LINE_ITEMS);
  registerUpdateTool(server, LINE_ITEMS);
}
