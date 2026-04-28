/**
 * Product tools — search, get, create, update.
 *
 * Products are the items in your HubSpot Products Library (the catalog used
 * to populate line items on deals, quotes, and invoices).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerCreateTool,
  registerGetTool,
  registerSearchTool,
  registerUpdateTool,
  type ObjectToolSpec,
} from './_factories.js';

const PRODUCTS: ObjectToolSpec = {
  toolNoun: 'products',
  singular: 'product',
  plural: 'products',
  apiPath: 'products',
  defaultProperties: [
    'name',
    'description',
    'price',
    'hs_sku',
    'hs_cost_of_goods_sold',
    'hs_url',
    'hs_recurring_billing_period',
    'hs_recurring_billing_terms',
    'createdate',
    'hs_lastmodifieddate',
  ],
  columns: [
    { property: 'name', label: 'name' },
    { property: 'hs_sku', label: 'sku' },
    { property: 'price', label: 'price' },
    { property: 'description', label: 'description' },
  ],
  titleProperty: 'name',
};

export function registerProductTools(server: McpServer): void {
  registerSearchTool(server, PRODUCTS);
  registerGetTool(server, PRODUCTS);
  registerCreateTool(server, PRODUCTS);
  registerUpdateTool(server, PRODUCTS);
}
