import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerAllTools, ALL_TOOL_NAMES } from '../src/tools/index.js';
import { hubspotRequest } from '../src/services/hubspot-client.js';
vi.mock('../src/services/hubspot-client.js', () => ({ hubspotRequest: vi.fn() }));
const request = vi.mocked(hubspotRequest);
function tool(name: string) {
  const registerTool = vi.fn();
  registerAllTools({ registerTool } as never);
  const call = registerTool.mock.calls.find(c => c[0] === name);
  expect(call, `registered ${name}`).toBeDefined();
  return { config: call![1], run: (args: unknown) => call![2](z.object(call![1].inputSchema).parse(args)) };
}
beforeEach(() => { request.mockReset(); });
const input = { body: 'Inbound SMS from Dan: Thanks!\nOriginal text preserved.', timestamp: '2026-10-01T12:34:56Z', owner_id: '700', contact_id: '100', deal_ids: ['200'], response_format: 'json' };
const properties = { hs_communication_channel_type: 'SMS', hs_communication_logged_from: 'CRM', hs_communication_body: input.body, hs_timestamp: input.timestamp, hubspot_owner_id: input.owner_id };
const record = (id = '900') => ({ id, properties, archived: false });
// Deliberately non-canonical IDs: prove IDs are discovered, not hardcoded.
const labels = (id: number) => ({ results: [{ category: 'HUBSPOT_DEFINED', typeId: id, label: null }] });
const links = (id: string, typeId = 501) => ({ results: [{ toObjectId: id, associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId, label: null }] }] });
function happy() {
  request.mockImplementation(async ({ path, method }) => {
    if (path === '/crm/v4/objects/contacts/100/associations/communications') return { results: [] };
    if (path === '/crm/v4/associations/communications/contacts/labels') return labels(501);
    if (path === '/crm/v4/associations/communications/deals/labels') return labels(502);
    if (path === '/crm/v3/objects/communications' && method === 'POST') return record();
    if (path === '/crm/v3/objects/communications/900') return record();
    if (path === '/crm/v4/objects/communications/900/associations/contacts') return links('100');
    if (path === '/crm/v4/objects/communications/900/associations/deals') return links('200', 502);
    if (path === '/crm/v4/objects/communications/900/associations/companies') return { results: [] };
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
}
const creates = () => request.mock.calls.filter(([o]) => o.path === '/crm/v3/objects/communications' && o.method === 'POST');
it('logs SMS/CRM with exact body/time/owner, discovered associations and readback, never sends', async () => {
  happy();
  const result = await tool('hubspot_create_communication').run(input);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ status: 'created', verified: true, communication: { id: '900', properties } });
  expect(result.structuredContent.communication.fullAssociations).toMatchObject({ contacts: [{ toObjectId: '100' }], deals: [{ toObjectId: '200' }], companies: [] });
  expect(creates()).toHaveLength(1);
  expect(creates()[0][0]).toMatchObject({ retryOnRateLimit: false, body: { properties, associations: [
    { to: { id: '100' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 501 }] },
    { to: { id: '200' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 502 }] },
  ] } });
  expect(request.mock.calls.every(([o]) => o.path.startsWith('/crm/'))).toBe(true);
  expect(request.mock.calls.filter(([o]) => o.method === 'POST')).toHaveLength(1);
});

it('reads and exposes extra associations even when no deals were requested', async () => {
  happy();
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => {
    if (o.path === '/crm/v4/objects/communications/900/associations/deals') return links('299', 777);
    if (o.path === '/crm/v4/objects/communications/900/associations/companies') return links('399', 778);
    return impl(o);
  });
  const result = await tool('hubspot_create_communication').run({ ...input, deal_ids: [] });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.communication.fullAssociations).toMatchObject({ deals: [{ toObjectId: '299' }], companies: [{ toObjectId: '399' }] });
});

it('returns an exact existing contact-scoped SMS instead of creating a duplicate', async () => {
  happy();
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => o.path === '/crm/v4/objects/contacts/100/associations/communications' ? links('900') : impl(o));
  const result = await tool('hubspot_create_communication').run(input);
  expect(result.structuredContent).toMatchObject({ status: 'existing', verified: true, communication: { id: '900' } });
  expect(creates()).toHaveLength(0);
});

it('returns structured correlation and the known ID when an existing match fails verification', async () => {
  happy();
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => {
    if (o.path === '/crm/v4/objects/contacts/100/associations/communications') return links('900');
    if (o.path === '/crm/v3/objects/communications/900') return { ...record(), properties: { ...properties, hubspot_owner_id: '701' } };
    return impl(o);
  });
  const result = await tool('hubspot_create_communication').run(input);
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'uncertain', candidate_ids: ['900'], contact_id: '100', timestamp: input.timestamp, phase: 'verification' } });
  expect(creates()).toHaveLength(0);
});

it('returns structured IDs and correlation for multiple existing matches', async () => {
  happy();
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => {
    if (o.path === '/crm/v4/objects/contacts/100/associations/communications') return { results: [links('900').results[0], links('901').results[0]] };
    if (o.path === '/crm/v3/objects/communications/901') return record('901');
    return impl(o);
  });
  const result = await tool('hubspot_create_communication').run(input);
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'uncertain', candidate_ids: ['900', '901'], contact_id: '100', timestamp: input.timestamp, phase: 'dedupe' } });
  expect(creates()).toHaveLength(0);
});

it.each([
  { name: 'wrong ID', response: { ...record(), id: '901' } },
  { name: 'missing archived', response: { id: '900', properties } },
  { name: 'non-boolean archived', response: { ...record(), archived: 'false' } },
  { name: 'array properties', response: { ...record(), properties: [] } },
  { name: 'missing dedupe property', response: { ...record(), properties: { ...properties, hs_communication_body: undefined } }, remove: 'hs_communication_body' },
  { name: 'invalid timestamp', response: { ...record(), properties: { ...properties, hs_timestamp: 'not-a-date' } } },
])('blocks POST when an existing communication read is malformed: $name', async ({ response, remove }) => {
  happy();
  if (remove) delete (response.properties as Record<string, unknown>)[remove];
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => o.path === '/crm/v4/objects/contacts/100/associations/communications' ? links('900') :
    o.path === '/crm/v3/objects/communications/900' ? response : impl(o));
  const result = await tool('hubspot_create_communication').run(input);
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'not_written', contact_id: '100', timestamp: input.timestamp, phase: 'preread' } });
  expect(creates()).toHaveLength(0);
});

it('accepts numeric epoch milliseconds and normalized ISO timestamps on communication readback', async () => {
  happy();
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => o.path === '/crm/v3/objects/communications/900' ?
    { ...record(), properties: { ...properties, hs_timestamp: Date.parse(input.timestamp) } } : impl(o));
  const result = await tool('hubspot_create_communication').run(input);
  expect(result.structuredContent).toMatchObject({ status: 'created', verified: true });
});

it('detects an existing match when the API supplies numeric epoch milliseconds', async () => {
  happy();
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => {
    if (o.path === '/crm/v4/objects/contacts/100/associations/communications') return links('900');
    if (o.path === '/crm/v3/objects/communications/900') return { ...record(), properties: { ...properties, hs_timestamp: Date.parse(input.timestamp) } };
    return impl(o);
  });
  const result = await tool('hubspot_create_communication').run(input);
  expect(result.structuredContent).toMatchObject({ status: 'existing', verified: true });
  expect(creates()).toHaveLength(0);
});

it.each([null, 1, 'bad', {}, { category: 'HUBSPOT_DEFINED', typeId: 501, label: [] }])('rejects malformed association label entries %#', async entry => {
  happy();
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => o.path === '/crm/v4/associations/communications/contacts/labels' ? { results: [entry] } : impl(o));
  const result = await tool('hubspot_create_communication').run(input);
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'not_written', phase: 'preread' } });
  expect(creates()).toHaveLength(0);
});

it('reconciles a lost create response by newly associated IDs, without another POST', async () => {
  happy();
  const impl = request.getMockImplementation()!;
  let posted = false;
  request.mockImplementation(async o => {
    if (o.path === '/crm/v3/objects/communications' && o.method === 'POST') { posted = true; throw new Error('connection lost'); }
    if (posted && o.path === '/crm/v4/objects/contacts/100/associations/communications') return links('900');
    return impl(o);
  });
  const result = await tool('hubspot_create_communication').run(input);
  expect(result.structuredContent).toMatchObject({ status: 'reconciled', verified: true, communication: { id: '900' } });
  expect(creates()).toHaveLength(1);
});

it('checks later association pages before creating', async () => {
  happy();
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => {
    if (o.path === '/crm/v4/objects/contacts/100/associations/communications') return o.query?.after ? links('900') : { results: [], paging: { next: { after: 'next' } } };
    return impl(o);
  });
  const result = await tool('hubspot_create_communication').run(input);
  expect(result.structuredContent).toMatchObject({ status: 'existing' });
  expect(creates()).toHaveLength(0);
});

it.each(['missing', 'cycle', 'null-paging', 'primitive-paging', 'null-next', 'primitive-next'])('fails closed on %s association pagination', async mode => {
  happy();
  const impl = request.getMockImplementation()!;
  request.mockImplementation(async o => o.path.includes('/contacts/100/associations/') ? (mode === 'missing' ? {} : mode === 'cycle' ? { results: [], paging: { next: { after: 'repeat' } } } : mode === 'null-paging' ? { results: [], paging: null } : mode === 'primitive-paging' ? { results: [], paging: 1 } : mode === 'null-next' ? { results: [], paging: { next: null } } : { results: [], paging: { next: 'bad' } }) : impl(o));
  const result = await tool('hubspot_create_communication').run(input);
  expect(result.isError).toBe(true);
  expect(creates()).toHaveLength(0);
});

it.each(['readback', 'reconcile'])('returns an explicit uncertain outcome and IDs after a %s failure', async stage => {
  happy();
  const impl = request.getMockImplementation()!;
  let posted = false;
  request.mockImplementation(async o => {
    if (o.path === '/crm/v3/objects/communications' && o.method === 'POST') {
      posted = true;
      if (stage === 'reconcile') throw new Error('socket reset');
    }
    if (posted && (stage === 'reconcile' || o.path === '/crm/v3/objects/communications/900')) throw new Error('API unavailable');
    return impl(o);
  });
  // For readback, return an ID then fail the GET (not the create).
  if (stage === 'readback') {
    request.mockImplementation(async o => {
      if (o.path === '/crm/v3/objects/communications/900') throw new Error('API unavailable');
      return impl(o);
    });
  }
  const result = await tool('hubspot_create_communication').run(input);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ status: 'uncertain', verified: false, candidate_ids: stage === 'readback' ? ['900'] : [], contact_id: '100', timestamp: input.timestamp });
  expect(result.content[0].text).toMatch(/do not retry/i);
  expect(creates()).toHaveLength(1);
});

describe('communications discovery', () => {
  it('registers read-only search/get and a non-idempotent logging-only create', () => {
    for (const name of ['hubspot_search_communications', 'hubspot_get_communication', 'hubspot_create_communication']) {
      expect(ALL_TOOL_NAMES).toContain(name);
      const { config } = tool(name);
      const readOnly = !name.includes('create');
      expect(config.annotations).toEqual({ readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true });
    }
    expect(tool('hubspot_create_communication').config.description).toMatch(/never sends/i);
    expect(tool('hubspot_describe_object').config.inputSchema.objectType.parse('communications')).toBe('communications');
  });
});
