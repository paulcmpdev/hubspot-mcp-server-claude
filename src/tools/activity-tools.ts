import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hubspotRequest } from '../services/hubspot-client.js';
import type { HubSpotObject } from '../types.js';
import { ResponseFormat } from '../schemas/common.js';
import { stringifyProperties } from '../schemas/common.js';
import { toolError, toolResult } from './_helpers.js';

const Id = z.string().regex(/^[1-9]\d*$/, 'Use an unmodified positive HubSpot ID.');
const CallStatus = z.enum(['BUSY', 'CALLING_CRM_USER', 'CANCELED', 'COMPLETED', 'CONNECTING', 'FAILED', 'IN_PROGRESS', 'NO_ANSWER', 'QUEUED', 'RINGING']);
const CallDirection = z.enum(['INBOUND', 'OUTBOUND']);
const Timestamp = z.string().datetime({ offset: true });
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const CALL_PROPERTIES = ['hs_call_title', 'hs_call_body', 'hs_call_direction', 'hs_call_duration', 'hs_call_disposition', 'hs_call_status', 'hs_timestamp', 'hubspot_owner_id'];
const NOTE_PROPERTIES = ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id', 'hs_attachment_ids'];

type AssociationType = { category: string; typeId: number; label?: string | null };
type Association = { toObjectId: string | number; associationTypes: AssociationType[] };
function validApiId(value: unknown): boolean {
  return typeof value === 'string' ? Id.safeParse(value).success : typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validAssociationType(value: unknown): value is AssociationType {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AssociationType>;
  return typeof item.category === 'string' && item.category.length > 0 && Number.isSafeInteger(item.typeId) && item.typeId! > 0 &&
    (item.label === undefined || item.label === null || typeof item.label === 'string');
}

export async function readAllAssociations(from: string, id: string, to: string): Promise<Association[]> {
  const all: Association[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await hubspotRequest<{ results?: Association[]; paging?: { next?: { after?: unknown } } }>({
      path: `/crm/v4/objects/${from}/${id}/associations/${to}`,
      query: { limit: 500, after },
    });
    if (!response || typeof response !== 'object' || Array.isArray(response) || !Array.isArray(response.results) || response.results.some(link => !validApiId(link?.toObjectId) || !Array.isArray(link?.associationTypes) || !link.associationTypes.every(validAssociationType))) {
      throw new Error('Malformed association page; refusing a partial result.');
    }
    all.push(...response.results);
    if (!Object.prototype.hasOwnProperty.call(response, 'paging')) return all;
    const paging = response.paging;
    if (!paging || typeof paging !== 'object' || Array.isArray(paging) || !Object.prototype.hasOwnProperty.call(paging, 'next') ||
      !paging.next || typeof paging.next !== 'object' || Array.isArray(paging.next)) {
      throw new Error('Malformed association pagination; refusing a partial result.');
    }
    const next = paging.next.after;
    if (typeof next !== 'string' || !next || cursors.has(next)) throw new Error('Malformed or cyclic association pagination; refusing a partial result.');
    cursors.add(next);
    after = next;
  }
  throw new Error('Association scan exceeded 20 pages; refusing a partial result.');
}

async function readActivity(type: 'calls' | 'notes', id: string, properties: string[]): Promise<HubSpotObject> {
  const activity = await hubspotRequest<HubSpotObject>({ path: `/crm/v3/objects/${type}/${id}`, query: { properties: properties.join(',') } });
  if (activity?.id !== id || !activity.properties || typeof activity.properties !== 'object' || Array.isArray(activity.properties)) {
    throw new Error(`Malformed ${type} read response for ${id}.`);
  }
  if (activity.archived === true) throw new Error(`${type} ${id} is archived.`);
  return activity;
}

function epochInstant(value: unknown): number | undefined {
  const epoch = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(epoch) && Number.isFinite(new Date(epoch).getTime()) ? epoch : undefined;
}

function propertyMatches(properties: HubSpotObject['properties'], key: string, expected: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(properties, key)) return false;
  if (key === 'hs_timestamp') {
    const actualEpoch = epochInstant(properties[key]);
    const expectedEpoch = epochInstant(expected);
    return actualEpoch !== undefined && expectedEpoch !== undefined && actualEpoch === expectedEpoch;
  }
  return expected === '' && properties[key] === null ? true : String(properties[key]) === expected;
}

function registerUpdate(server: McpServer, config: {
  type: 'calls' | 'notes'; singular: 'call' | 'note'; properties: string[]; schema: Record<string, z.ZodTypeAny>;
}): void {
  server.registerTool(`hubspot_update_${config.singular}`, {
    title: `Update ${config.singular}`,
    description: `Update only the documented, allowlisted ${config.singular} fields. The record is read before and after PATCH; an uncertain write returns its known ID and phase. Clear an allowlisted value with an empty string.`,
    annotations: writeAnnotations,
    inputSchema: { id: Id, ...config.schema, response_format: ResponseFormat },
  }, async (args) => {
    const allowed = new Set(Object.keys(config.schema));
    const properties = stringifyProperties(Object.fromEntries(Object.entries(args).filter(([key, value]) => allowed.has(key) && value !== undefined)));
    if (!Object.keys(properties).length) return toolError('Provide at least one allowlisted property to update.');
    try {
      await readActivity(config.type, args.id, config.properties);
    } catch (err) {
      return toolError(`Pre-read failed; no write attempted: ${err instanceof Error ? err.message : String(err)}`, { status: 'not_written', verified: false, id: args.id, phase: 'preread' });
    }
    let writeError: unknown;
    try {
      await hubspotRequest({ path: `/crm/v3/objects/${config.type}/${args.id}`, method: 'PATCH', retryOnRateLimit: false, body: { properties } });
      const activity = await readActivity(config.type, args.id, config.properties);
      const mismatch = Object.entries(properties).find(([key, value]) => !propertyMatches(activity.properties, key, value));
      if (mismatch) throw new Error(`Readback mismatch for ${mismatch[0]}.`);
      const result = { status: 'updated', verified: true, id: args.id, activity };
      return toolResult(JSON.stringify(result, null, 2), result);
    } catch (err) {
      writeError = err;
    }
    try {
      const activity = await readActivity(config.type, args.id, config.properties);
      const mismatch = Object.entries(properties).find(([key, value]) => !propertyMatches(activity.properties, key, value));
      if (!mismatch) {
        const result = { status: 'recovered', verified: true, id: args.id, activity };
        return toolResult(JSON.stringify(result, null, 2), result);
      }
    } catch { /* Preserve the original write/verification failure below. */ }
    return toolError(`Update outcome uncertain for ${config.singular} ${args.id}; do not retry automatically. Re-read and reconcile by ID. Cause: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
      { status: 'uncertain', verified: false, id: args.id, candidate_ids: [args.id], phase: 'write_or_verification' });
  });
}

export function registerActivityTools(server: McpServer): void {
  registerUpdate(server, { type: 'calls', singular: 'call', properties: CALL_PROPERTIES, schema: {
    hs_call_title: z.string().max(65536).optional(), hs_call_body: z.string().max(65536).optional(),
    hs_call_direction: z.union([CallDirection, z.literal('')]).optional(), hs_call_duration: z.union([z.number().int().nonnegative().safe(), z.literal('')]).optional(),
    hs_call_disposition: z.string().optional(), hs_call_status: z.union([CallStatus, z.literal('')]).optional(),
    hs_timestamp: Timestamp.optional(), hubspot_owner_id: z.union([Id, z.literal('')]).optional(),
  } });
  registerUpdate(server, { type: 'notes', singular: 'note', properties: NOTE_PROPERTIES, schema: {
    hs_note_body: z.string().max(65536).optional(), hs_timestamp: Timestamp.optional(),
    hubspot_owner_id: z.union([Id, z.literal('')]).optional(), hs_attachment_ids: z.string().regex(/^$|^[1-9]\d*(;[1-9]\d*)*$/).optional(),
  } });

  server.registerTool('hubspot_get_activity_associations', {
    title: 'Get all activity associations',
    description: 'Read a complete, bounded, paginated set of contact, company, or deal associations for a call, note, or communication. Fails closed instead of returning partial results.',
    annotations: readAnnotations,
    inputSchema: { activity_type: z.enum(['calls', 'notes', 'communications']), activity_id: Id, associated_type: z.enum(['contacts', 'companies', 'deals']), response_format: ResponseFormat },
  }, async (args) => {
    try {
      const associations = await readAllAssociations(args.activity_type, args.activity_id, args.associated_type);
      const result = { activity_type: args.activity_type, activity_id: args.activity_id, associated_type: args.associated_type, complete: true, associations };
      return toolResult(JSON.stringify(result, null, 2), result);
    } catch (err) { return toolError(err instanceof Error ? err.message : String(err)); }
  });
}
