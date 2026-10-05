import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools, ALL_TOOL_NAMES } from '../src/tools/index.js';
import { hubspotRequest } from '../src/services/hubspot-client.js';

vi.mock('../src/services/hubspot-client.js', () => ({ hubspotRequest: vi.fn() }));
const request = vi.mocked(hubspotRequest);
function tool(name: string) {
  const registerTool = vi.fn();
  registerAllTools({ registerTool } as never);
  const call = registerTool.mock.calls.find(c => c[0] === name)!;
  expect(call).toBeDefined();
  return { config: call[1], run: (args: unknown) => call[2](z.object(call[1].inputSchema).parse(args)) };
}
beforeEach(() => request.mockReset());

describe('activity registration and validation', () => {
  it('registers call/note get and narrow updates plus a read-only association reader', () => {
    for (const name of ['hubspot_get_call', 'hubspot_get_note', 'hubspot_update_call', 'hubspot_update_note', 'hubspot_get_activity_associations']) expect(ALL_TOOL_NAMES).toContain(name);
    expect(tool('hubspot_get_call').config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tool('hubspot_get_note').config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tool('hubspot_get_activity_associations').config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tool('hubspot_update_call').config.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });

  it('rejects invalid call status, empty timestamps, malformed IDs and unsafe numeric IDs before requests', () => {
    const schema = z.object(tool('hubspot_update_call').config.inputSchema);
    expect(() => schema.parse({ id: '1', hs_call_status: 'DONE', response_format: 'json' })).toThrow();
    expect(() => schema.parse({ id: '1', hs_timestamp: '', response_format: 'json' })).toThrow();
    expect(() => schema.parse({ id: '01', hs_call_status: 'COMPLETED', response_format: 'json' })).toThrow();
    expect(() => schema.parse({ id: 9007199254740992, hs_call_status: 'COMPLETED', response_format: 'json' })).toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('advertises schemas through MCP and safely strips unknown input fields in the actual transport', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    registerAllTools(server);
    const client = new Client({ name: 'test-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const update = listed.tools.find(candidate => candidate.name === 'hubspot_update_call');
      expect(update?.inputSchema).toMatchObject({ type: 'object', properties: { id: {}, hs_call_status: {} } });
      request.mockResolvedValueOnce({ id: '7', properties: {}, archived: false })
        .mockResolvedValueOnce({ id: '7', properties: {}, archived: false })
        .mockResolvedValueOnce({ id: '7', properties: { hs_call_status: 'COMPLETED' }, archived: false });
      const result = await client.callTool({ name: 'hubspot_update_call', arguments: { id: '7', hs_call_status: 'COMPLETED', invented_direction: 'SIDEWAYS', response_format: 'json' } });
      expect(result.structuredContent).toMatchObject({ status: 'updated', verified: true });
      expect(request.mock.calls[1]![0]).toMatchObject({ body: { properties: { hs_call_status: 'COMPLETED' } } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('narrow updates', () => {
  it('does not write when preread fails', async () => {
    request.mockRejectedValueOnce(new Error('not readable'));
    const result = await tool('hubspot_update_note').run({ id: '7', hs_note_body: 'x', response_format: 'json' });
    expect(result).toMatchObject({ isError: true, structuredContent: { status: 'not_written', id: '7', phase: 'preread' } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not write after a malformed preread', async () => {
    request.mockResolvedValueOnce({ id: 'wrong', properties: {} });
    const result = await tool('hubspot_update_call').run({ id: '7', hs_call_status: 'COMPLETED', response_format: 'json' });
    expect(result).toMatchObject({ isError: true, structuredContent: { status: 'not_written', phase: 'preread' } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not write when the preread record is archived', async () => {
    request.mockResolvedValueOnce({ id: '7', properties: {}, archived: true });
    const result = await tool('hubspot_update_call').run({ id: '7', hs_call_status: 'COMPLETED', response_format: 'json' });
    expect(result).toMatchObject({ isError: true, structuredContent: { status: 'not_written', phase: 'preread' } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('writes only allowlisted typed fields and verifies property readback', async () => {
    request.mockResolvedValueOnce({ id: '7', properties: {} }).mockResolvedValueOnce({ id: '7', properties: {} })
      .mockResolvedValueOnce({ id: '7', properties: { hs_call_status: 'COMPLETED', hs_call_duration: '12' } });
    const result = await tool('hubspot_update_call').run({ id: '7', hs_call_status: 'COMPLETED', hs_call_duration: 12, response_format: 'json' });
    expect(result.structuredContent).toMatchObject({ status: 'updated', verified: true, id: '7' });
    expect(request.mock.calls[1]![0]).toMatchObject({ method: 'PATCH', retryOnRateLimit: false, body: { properties: { hs_call_status: 'COMPLETED', hs_call_duration: '12' } } });
  });

  it('returns structured uncertainty with the known ID when verification cannot recover', async () => {
    request.mockResolvedValueOnce({ id: '7', properties: {} }).mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('down'));
    const result = await tool('hubspot_update_note').run({ id: '7', hs_note_body: 'x', response_format: 'json' });
    expect(result).toMatchObject({ isError: true, structuredContent: { status: 'uncertain', verified: false, id: '7', candidate_ids: ['7'], phase: 'write_or_verification' } });
  });

  it('verifies timestamps by finite epoch instant, including numeric API milliseconds', async () => {
    const instant = Date.parse('2026-10-01T12:34:56.000Z');
    request.mockResolvedValueOnce({ id: '7', properties: {}, archived: false }).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ id: '7', properties: { hs_timestamp: instant }, archived: false });
    const result = await tool('hubspot_update_note').run({ id: '7', hs_timestamp: '2026-10-01T08:34:56-04:00', response_format: 'json' });
    expect(result.structuredContent).toMatchObject({ status: 'updated', verified: true });
  });

  it('does not treat a missing readback property as a successful clear', async () => {
    request.mockResolvedValueOnce({ id: '7', properties: {}, archived: false }).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ id: '7', properties: {}, archived: false })
      .mockResolvedValueOnce({ id: '7', properties: {}, archived: false });
    const result = await tool('hubspot_update_note').run({ id: '7', hs_note_body: '', response_format: 'json' });
    expect(result).toMatchObject({ isError: true, structuredContent: { status: 'uncertain' } });
  });

  it('accepts a present null readback as proof of an optional field clear', async () => {
    request.mockResolvedValueOnce({ id: '7', properties: {}, archived: false }).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ id: '7', properties: { hs_note_body: null }, archived: false });
    const result = await tool('hubspot_update_note').run({ id: '7', hs_note_body: '', response_format: 'json' });
    expect(result.structuredContent).toMatchObject({ status: 'updated', verified: true });
  });
});

describe('full activity associations', () => {
  it('adds complete requested associations to get-call output instead of hiding later pages', async () => {
    request.mockResolvedValueOnce({ id: '1', properties: {} })
      .mockResolvedValueOnce({ results: [{ toObjectId: '2', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 1 }] }], paging: { next: { after: 'n' } } })
      .mockResolvedValueOnce({ results: [{ toObjectId: '3', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 1 }] }] });
    const result = await tool('hubspot_get_call').run({ id: '1', associations: ['deals'], response_format: 'json' });
    expect(result.structuredContent.fullAssociations.deals).toMatchObject([{ toObjectId: '2' }, { toObjectId: '3' }]);
  });

  it('returns extra associations across every page', async () => {
    request.mockResolvedValueOnce({ results: [{ toObjectId: '2', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 1 }] }], paging: { next: { after: 'n' } } })
      .mockResolvedValueOnce({ results: [{ toObjectId: '3', associationTypes: [{ category: 'USER_DEFINED', typeId: 2, label: 'Extra' }] }] });
    const result = await tool('hubspot_get_activity_associations').run({ activity_type: 'calls', activity_id: '1', associated_type: 'companies', response_format: 'json' });
    expect(result.structuredContent).toMatchObject({ complete: true, associations: [{ toObjectId: '2' }, { toObjectId: '3' }] });
  });

  it.each([{ results: 'bad' }, { results: [{ toObjectId: 9007199254740992, associationTypes: [] }] }, { results: [{ toObjectId: '2', associationTypes: [{}] }] }, { results: [], paging: null }, { results: [], paging: 1 }, { results: [], paging: { next: null } }, { results: [], paging: { next: 'bad' } }, { results: [], paging: { next: { after: '' } } }])('fails closed on malformed pages', async response => {
    request.mockResolvedValue(response);
    const result = await tool('hubspot_get_activity_associations').run({ activity_type: 'notes', activity_id: '1', associated_type: 'deals', response_format: 'json' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
