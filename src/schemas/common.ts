/**
 * Shared Zod building blocks. Tool-specific input schemas live alongside their
 * tool definitions — this file contains only widely-reused fragments.
 */

import { z } from 'zod';
import { MAX_PAGE_SIZE } from '../constants.js';

export const ResponseFormat = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe('Output format. Use "json" for programmatic consumption.');

/** A standard "limit" field, capped at HubSpot's 100/page max. */
export const Limit = z.number().int().min(1).max(MAX_PAGE_SIZE).optional()
  .describe('Maximum results to return (1-100). Defaults to 50.');

/** A pagination cursor. */
export const After = z.string().optional()
  .describe('Pagination cursor from a previous response\'s `paging.next.after`.');

/** Property name list. */
export const PropertyList = z.array(z.string().min(1)).optional()
  .describe('Property names to include in the response. If omitted, HubSpot returns its default set.');

/** Sort spec. */
export const Sorts = z
  .array(
    z.object({
      propertyName: z.string().min(1),
      direction: z.enum(['ASCENDING', 'DESCENDING']),
    }),
  )
  .optional()
  .describe('Sort order. Each entry is `{ propertyName, direction }`.');

/** Filter operator union — matches HubSpot's CRM Search API. */
export const FilterOperator = z.enum([
  'EQ',
  'NEQ',
  'LT',
  'LTE',
  'GT',
  'GTE',
  'BETWEEN',
  'IN',
  'NOT_IN',
  'HAS_PROPERTY',
  'NOT_HAS_PROPERTY',
  'CONTAINS_TOKEN',
  'NOT_CONTAINS_TOKEN',
]);

export const SearchFilter = z.object({
  propertyName: z.string().min(1),
  operator: FilterOperator,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  values: z.array(z.union([z.string(), z.number()])).optional(),
  highValue: z.union([z.string(), z.number()]).optional(),
});

export const FilterGroups = z
  .array(z.object({ filters: z.array(SearchFilter).min(1).max(6) }))
  .max(5)
  .optional()
  .describe(
    'Filter groups. Filters within a group are AND-ed, groups are OR-ed. Max 5 groups, 6 filters/group, 18 total.',
  );

/** Free-text search query (used by /search endpoints). */
export const SearchQuery = z.string().optional()
  .describe('Free-text search across default searchable properties.');

/** Bag of property values for create/update. HubSpot expects strings; we coerce numbers/booleans. */
export const PropertyBag = z
  .record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe(
    'Object properties. Keys are HubSpot internal property names (e.g. `firstname`, `dealstage`). ' +
      'Use the `hubspot_describe_object` tool to discover available properties.',
  );

/** Associations spec for object creation (v3 batch-create style). */
export const Associations = z
  .array(
    z.object({
      to: z.object({ id: z.string().min(1) }),
      types: z
        .array(
          z.object({
            associationCategory: z.enum(['HUBSPOT_DEFINED', 'USER_DEFINED', 'INTEGRATOR_DEFINED']),
            associationTypeId: z.number().int().nonnegative(),
          }),
        )
        .min(1),
    }),
  )
  .optional()
  .describe(
    'Associations to other CRM records. ' +
      'See https://developers.hubspot.com/docs/guides/api/crm/associations for type IDs ' +
      '(common: contact↔company=1, contact↔deal=4, contact↔ticket=15, task↔contact=204, ' +
      'note↔contact=202, call↔contact=194, meeting↔contact=200, email↔contact=198).',
  );

/** Coerce property bag values to the strings HubSpot's API expects. */
export function stringifyProperties(props: Record<string, string | number | boolean | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null) continue;
    out[k] = String(v);
  }
  return out;
}
