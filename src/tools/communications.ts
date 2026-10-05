/** Logged external SMS activities, NOT a message transport. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetTool, registerSearchTool, type ObjectToolSpec } from './_factories.js';
import { toolError, toolResult } from './_helpers.js';
import { z } from 'zod';
import { ResponseFormat } from '../schemas/common.js';
import { hubspotRequest } from '../services/hubspot-client.js';
import type { HubSpotObject } from '../types.js';
import { readAllAssociations } from './activity-tools.js';

const Id = z.string().regex(/^[1-9]\d*$/, 'Use an unmodified positive HubSpot ID.');
const inputSchema = {
  body: z.string().min(1).refine(s => s.trim().length > 0).describe('Exact logged text. For inbound messages explicitly identify the sender and inbound direction here; no undocumented direction property is written.'),
  timestamp: z.string().datetime({ offset: true }).describe('Original SMS timestamp, ISO 8601 with timezone; never defaults to now.'),
  owner_id: Id.describe('HubSpot owner ID, not user ID.'),
  contact_id: Id.describe('Contact whose SMS is being logged; duplicate checks are scoped to this contact.'),
  deal_ids: z.array(Id).max(20).default([]).describe('Existing deal IDs to associate; no deal is modified.'),
  response_format: ResponseFormat,
};
type Input = z.infer<z.ZodObject<typeof inputSchema>>;
type Label = { category: string; typeId: number; label?: string | null };
type Link = { toObjectId: string | number; associationTypes: Label[] };
async function associationLinks(from: string, id: string, to: string): Promise<Link[]> {
  return readAllAssociations(from, id, to) as Promise<Link[]>;
}
async function associationType(to: string): Promise<number> {
  const data = await hubspotRequest<{ results: Label[] }>({ path: `/crm/v4/associations/communications/${to}/labels` });
  if (!Array.isArray(data?.results) || !data.results.every(label => label && typeof label === 'object' && !Array.isArray(label) &&
    typeof label.category === 'string' && label.category.length > 0 && Number.isSafeInteger(label.typeId) && label.typeId > 0 &&
    (label.label === undefined || label.label === null || typeof label.label === 'string'))) {
    throw new Error(`Malformed communications -> ${to} association labels response.`);
  }
  const defaults = data.results.filter(l => l.category === 'HUBSPOT_DEFINED' && l.label == null);
  if (defaults.length !== 1 || !Number.isSafeInteger(defaults[0]!.typeId) || defaults[0]!.typeId <= 0) throw new Error(`Cannot uniquely discover communications -> ${to} default association.`);
  return defaults[0]!.typeId;
}
async function matchingIds(args: Input): Promise<string[]> {
  // Do not depend on the eventually-consistent CRM search index for dedupe.
  const links = await associationLinks('contacts', args.contact_id, 'communications');
  const ids: string[] = [];
  for (const id of new Set(links.map(l => String(l.toObjectId)))) {
    const obj = await readCommunication(id);
    if (!obj.archived && obj.properties.hs_communication_channel_type === 'SMS' &&
      obj.properties.hs_communication_body === args.body &&
      timestampEpoch(obj.properties.hs_timestamp) === timestampEpoch(args.timestamp)) ids.push(id);
  }
  return ids;
}
function expectedProperties(args: Input): Record<string, string> {
  return { hs_communication_channel_type: 'SMS', hs_communication_logged_from: 'CRM', hs_communication_body: args.body, hs_timestamp: args.timestamp, hubspot_owner_id: args.owner_id };
}
async function readCommunication(id: string): Promise<HubSpotObject> {
  const obj = await hubspotRequest<HubSpotObject>({ path: `/crm/v3/objects/communications/${id}`, query: { properties: PROPERTIES.join(',') } });
  if (!obj || obj.id !== id || typeof obj.archived !== 'boolean' || !obj.properties || typeof obj.properties !== 'object' || Array.isArray(obj.properties) ||
    PROPERTIES.some(key => !Object.prototype.hasOwnProperty.call(obj.properties, key)) || !Number.isFinite(timestampEpoch(obj.properties.hs_timestamp))) {
    throw new Error(`Malformed communication read response for ${id}.`);
  }
  return obj;
}
function timestampEpoch(value: unknown): number {
  const epoch = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(epoch) && Number.isFinite(new Date(epoch).getTime()) ? epoch : NaN;
}
async function verify(id: string, args: Input, contactType: number, dealType?: number): Promise<HubSpotObject & { fullAssociations: Record<string, Link[]> }> {
  const obj = await readCommunication(id);
  if (obj.archived || Object.entries(expectedProperties(args)).some(([key, value]) => key === 'hs_timestamp'
    ? timestampEpoch(obj.properties[key]) !== timestampEpoch(value)
    : String(obj.properties[key]) !== value)) throw new Error(`Readback properties mismatch for communication ${id}.`);
  const fullAssociations: Record<string, Link[]> = {};
  for (const [type, ids, typeId] of [['contacts', [args.contact_id], contactType], ['deals', args.deal_ids, dealType], ['companies', [], undefined]] as const) {
    const links = await associationLinks('communications', id, type);
    fullAssociations[type] = links;
    if (ids.some(target => !links.some(l => String(l.toObjectId) === target && l.associationTypes.some(t => t.category === 'HUBSPOT_DEFINED' && t.typeId === typeId)))) throw new Error(`Readback ${type} associations mismatch for communication ${id}.`);
  }
  return { ...obj, fullAssociations };
}

const PROPERTIES = ['hs_communication_channel_type', 'hs_communication_logged_from', 'hs_communication_body', 'hs_timestamp', 'hubspot_owner_id'];
const COMMUNICATIONS: ObjectToolSpec = {
  toolNoun: 'communications', singular: 'communication', plural: 'communications', apiPath: 'communications',
  defaultProperties: PROPERTIES,
  columns: [{ property: 'hs_communication_channel_type', label: 'channel' }, { property: 'hs_communication_body', label: 'body' }, { property: 'hs_timestamp', label: 'when' }],
  readAnnotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  idSchema: Id,
  associationReader: readAllAssociations,
  associationTypeSchema: z.enum(['contacts', 'companies', 'deals']),
};
export function registerCommunicationTools(server: McpServer): void {
  registerSearchTool(server, COMMUNICATIONS);
  registerGetTool(server, COMMUNICATIONS);
  server.registerTool('hubspot_create_communication', {
    title: 'Log an external SMS activity',
    description: 'Logs an already received or sent SMS on the CRM timeline; never sends a message.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema,
  }, async (args) => {
    let knownId: string | undefined;
    let phase = 'preread';
    try {
      const contactType = await associationType('contacts');
      const dealType = args.deal_ids.length ? await associationType('deals') : undefined;
      const existingIds = await matchingIds(args);
      if (existingIds.length > 1) return toolError(`Multiple matching SMS IDs: ${existingIds.join(', ')}. Reconcile them; do not create again.`,
        { status: 'uncertain', verified: false, candidate_ids: existingIds, contact_id: args.contact_id, timestamp: args.timestamp, phase: 'dedupe' });
      if (existingIds.length === 1) {
        knownId = existingIds[0]!;
        phase = 'verification';
        const communication = await verify(knownId, args, contactType, dealType);
        const result = { status: 'existing', verified: true, communication };
        return toolResult(JSON.stringify(result, null, 2), result);
      }
      const associations = [
        { to: { id: args.contact_id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: contactType }] },
        ...[...new Set(args.deal_ids)].map(id => ({ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: dealType! }] })),
      ];
      let id: string | undefined;
      let reconciled = false;
      try {
        phase = 'create';
        const created = await hubspotRequest<HubSpotObject>({ path: '/crm/v3/objects/communications', method: 'POST', retryOnRateLimit: false, body: { properties: expectedProperties(args), associations } });
        if (!Id.safeParse(created?.id).success) throw new Error('Create response omitted a valid communication ID.');
        id = created.id;
        knownId = id;
      } catch (createError) {
        // A timeout, 5xx or malformed success may hide a committed write. Never retry.
        phase = 'reconciliation';
        let ids: string[] = [];
        try { ids = await matchingIds(args); } catch (reconcileError) {
          return toolError(`Create outcome unknown and reconciliation failed. Do not retry; reconcile contact ${args.contact_id} by ID. Cause: ${createError instanceof Error ? createError.message : String(createError)}; reconciliation: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
            { status: 'uncertain', verified: false, candidate_ids: knownId ? [knownId] : [], contact_id: args.contact_id, timestamp: args.timestamp, phase });
        }
        if (ids.length !== 1) return toolError(`Create outcome unknown. Candidate communication IDs: ${ids.join(', ') || 'none visible'}. Do not retry; reconcile contact ${args.contact_id} by ID. Cause: ${createError instanceof Error ? createError.message : String(createError)}`,
          { status: 'uncertain', verified: false, candidate_ids: ids, contact_id: args.contact_id, timestamp: args.timestamp, phase });
        id = ids[0]!;
        knownId = id;
        reconciled = true;
      }
      phase = 'verification';
      const communication = await verify(id, args, contactType, dealType);
      const result = { status: reconciled ? 'reconciled' : 'created', verified: true, communication };
      return toolResult(JSON.stringify(result, null, 2), result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (knownId) return toolError(`Communication ${knownId} write or verification outcome is uncertain. Do not retry automatically; reconcile by ID. Cause: ${message}`,
        { status: 'uncertain', verified: false, candidate_ids: [knownId], contact_id: args.contact_id, timestamp: args.timestamp, phase });
      return toolError(message, { status: 'not_written', verified: false, candidate_ids: [], contact_id: args.contact_id, timestamp: args.timestamp, phase });
    }
  });
}
