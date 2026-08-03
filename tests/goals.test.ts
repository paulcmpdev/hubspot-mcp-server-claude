import { describe, expect, it, vi } from 'vitest';
import {
  applyGoalTargetUpdates,
  previewGoalTargetUpdates,
  type GoalTargetUpdate,
  type HubSpotRequestLike,
} from '../src/tools/goals.js';

const updates: GoalTargetUpdate[] = [
  { id: 'goal-jan', targetAmount: 12500, notifyOnEdit: false },
  { id: 'goal-feb', targetAmount: '13000.00' },
];

function batchReadResponse(
  janAmount = '10000',
  febAmount = '11000',
  options: { janNotify?: string; febNotify?: string; updatedAt?: string; status?: string } = {},
) {
  return {
    status: options.status ?? 'COMPLETE',
    results: [
      {
        id: 'goal-jan',
        properties: {
          hs_goal_name: '2026 Revenue Goal',
          hs_target_amount: janAmount,
          hs_should_notify_on_edit_updates: options.janNotify ?? 'true',
          hs_start_datetime: '2026-01-01T00:00:00Z',
          hs_end_datetime: '2026-01-31T23:59:59.999Z',
          hs_group_correlation_uuid: 'family-1',
          hs_goal_target_group_id: 'group-1',
        },
        updatedAt: options.updatedAt ?? '2026-01-01T12:00:00Z',
      },
      {
        id: 'goal-feb',
        properties: {
          hs_goal_name: '2026 Revenue Goal',
          hs_target_amount: febAmount,
          hs_should_notify_on_edit_updates: options.febNotify ?? 'false',
          hs_start_datetime: '2026-02-01T00:00:00Z',
          hs_end_datetime: '2026-02-28T23:59:59.999Z',
          hs_group_correlation_uuid: 'family-1',
          hs_goal_target_group_id: 'group-1',
        },
        updatedAt: options.updatedAt ?? '2026-01-01T12:00:00Z',
      },
    ],
  };
}

function successfulBatchUpdate(ids = ['goal-jan', 'goal-feb']) {
  return {
    status: 'COMPLETE',
    numErrors: 0,
    errors: [],
    results: ids.map((id) => ({ id, properties: {} })),
  };
}

describe('previewGoalTargetUpdates', () => {
  it('reads current targets and returns a deterministic, exact before/after plan', async () => {
    const request = vi.fn(async () => batchReadResponse()) as unknown as HubSpotRequestLike;

    const preview = await previewGoalTargetUpdates(updates, request);

    expect(request).toHaveBeenCalledWith({
      path: '/crm/v3/objects/goal_targets/batch/read',
      method: 'POST',
      body: {
        properties: expect.arrayContaining([
          'hs_goal_name',
          'hs_target_amount',
          'hs_should_notify_on_edit_updates',
          'hs_start_datetime',
          'hs_end_datetime',
        ]),
        propertiesWithHistory: [],
        inputs: [{ id: 'goal-jan' }, { id: 'goal-feb' }],
      },
    });
    expect(preview.approvalToken).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(preview.changes).toEqual([
      expect.objectContaining({
        id: 'goal-jan',
        before: '10000',
        after: '12500',
        beforeNotifyOnEdit: 'true',
        afterNotifyOnEdit: 'false',
      }),
      expect.objectContaining({ id: 'goal-feb', before: '11000', after: '13000.00' }),
    ]);

    const second = await previewGoalTargetUpdates([...updates].reverse(), request);
    expect(second.approvalToken).toBe(preview.approvalToken);
  });

  it('rejects duplicate IDs before calling HubSpot', async () => {
    const request = vi.fn() as unknown as HubSpotRequestLike;
    await expect(
      previewGoalTargetUpdates(
        [
          { id: 'goal-jan', targetAmount: 1 },
          { id: 'goal-jan', targetAmount: 2 },
        ],
        request,
      ),
    ).rejects.toThrow(/duplicate/i);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([' ', '0x10', '1e3', '-1', '1,000', '.5', 'NaN', 'Infinity'])(
    'rejects non-decimal target amount %j before calling HubSpot',
    async (targetAmount) => {
      const request = vi.fn() as unknown as HubSpotRequestLike;
      await expect(
        previewGoalTargetUpdates([{ id: 'goal-jan', targetAmount }], request),
      ).rejects.toThrow(/invalid target amount/i);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('rejects incomplete batch reads instead of treating them as current state', async () => {
    const request = vi.fn(async () => batchReadResponse('10000', '11000', { status: 'PENDING' })) as unknown as HubSpotRequestLike;
    await expect(previewGoalTargetUpdates(updates, request)).rejects.toThrow(/PENDING/);
  });

  it('rejects missing target IDs instead of silently producing a partial plan', async () => {
    const request = vi.fn(async () => ({
      status: 'COMPLETE',
      results: [batchReadResponse().results[0]],
    })) as unknown as HubSpotRequestLike;

    await expect(previewGoalTargetUpdates(updates, request)).rejects.toThrow(/goal-feb/);
  });
});

describe('applyGoalTargetUpdates', () => {
  it('refuses a stale or mismatched approval token without writing', async () => {
    const request = vi.fn(async () => batchReadResponse()) as unknown as HubSpotRequestLike;

    await expect(applyGoalTargetUpdates(updates, 'sha256:not-the-plan', request)).rejects.toThrow(
      /approval token/i,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects when live state changed after preview and before the update call', async () => {
    const previewRequest = vi.fn(async () => batchReadResponse()) as unknown as HubSpotRequestLike;
    const preview = await previewGoalTargetUpdates(updates, previewRequest);
    const request = vi.fn(async () => batchReadResponse('10001')) as unknown as HubSpotRequestLike;

    await expect(applyGoalTargetUpdates(updates, preview.approvalToken, request)).rejects.toThrow(
      /approval token/i,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('batch updates the approved plan and verifies amount plus notification state', async () => {
    const previewRequest = vi.fn(async () => batchReadResponse()) as unknown as HubSpotRequestLike;
    const preview = await previewGoalTargetUpdates(updates, previewRequest);

    const request = vi
      .fn()
      .mockResolvedValueOnce(batchReadResponse())
      .mockResolvedValueOnce(successfulBatchUpdate())
      .mockResolvedValueOnce(batchReadResponse('12500', '13000.00', { janNotify: 'false' })) as unknown as HubSpotRequestLike;

    const result = await applyGoalTargetUpdates(updates, preview.approvalToken, request);

    expect(request).toHaveBeenNthCalledWith(2, {
      path: '/crm/v3/objects/goal_targets/batch/update',
      method: 'POST',
      body: {
        inputs: [
          {
            id: 'goal-jan',
            properties: {
              hs_target_amount: '12500',
              hs_should_notify_on_edit_updates: 'false',
            },
          },
          { id: 'goal-feb', properties: { hs_target_amount: '13000.00' } },
        ],
      },
    });
    expect(result.verified).toBe(true);
    expect(result.verificationPerformed).toBe(true);
    expect(result.updatedIds).toEqual(['goal-jan', 'goal-feb']);
    expect(result.mismatches).toEqual([]);
  });

  it('compares decimal amounts exactly without JavaScript Number precision loss', async () => {
    const preciseUpdates: GoalTargetUpdate[] = [
      { id: 'goal-jan', targetAmount: '9007199254740993.00' },
    ];
    const current = {
      status: 'COMPLETE',
      results: [batchReadResponse().results[0]],
    };
    const previewRequest = vi.fn(async () => current) as unknown as HubSpotRequestLike;
    const preview = await previewGoalTargetUpdates(preciseUpdates, previewRequest);

    const wrongFinal = {
      status: 'COMPLETE',
      results: [{
        ...batchReadResponse().results[0],
        properties: {
          ...batchReadResponse().results[0]!.properties,
          hs_target_amount: '9007199254740992',
        },
      }],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(successfulBatchUpdate(['goal-jan']))
      .mockResolvedValueOnce(wrongFinal) as unknown as HubSpotRequestLike;

    const result = await applyGoalTargetUpdates(preciseUpdates, preview.approvalToken, request);
    expect(result.verified).toBe(false);
    expect(result.mismatches).toContainEqual({
      id: 'goal-jan',
      property: 'hs_target_amount',
      expected: '9007199254740993.00',
      actual: '9007199254740992',
    });
  });

  it('treats decimal formatting changes as the same exact decimal value', async () => {
    const previewRequest = vi.fn(async () => batchReadResponse()) as unknown as HubSpotRequestLike;
    const preview = await previewGoalTargetUpdates(updates, previewRequest);
    const request = vi
      .fn()
      .mockResolvedValueOnce(batchReadResponse())
      .mockResolvedValueOnce(successfulBatchUpdate())
      .mockResolvedValueOnce(batchReadResponse('12500.00', '13000', { janNotify: 'false' })) as unknown as HubSpotRequestLike;

    const result = await applyGoalTargetUpdates(updates, preview.approvalToken, request);
    expect(result.verified).toBe(true);
  });

  it('reports a notification mismatch instead of claiming success', async () => {
    const previewRequest = vi.fn(async () => batchReadResponse()) as unknown as HubSpotRequestLike;
    const preview = await previewGoalTargetUpdates(updates, previewRequest);
    const request = vi
      .fn()
      .mockResolvedValueOnce(batchReadResponse())
      .mockResolvedValueOnce(successfulBatchUpdate())
      .mockResolvedValueOnce(batchReadResponse('12500', '13000.00', { janNotify: 'true' })) as unknown as HubSpotRequestLike;

    const result = await applyGoalTargetUpdates(updates, preview.approvalToken, request);
    expect(result.verified).toBe(false);
    expect(result.mismatches).toContainEqual({
      id: 'goal-jan',
      property: 'hs_should_notify_on_edit_updates',
      expected: 'false',
      actual: 'true',
    });
  });

  it.each([
    ['PENDING response', { status: 'PENDING', results: [] }],
    ['error response', { status: 'COMPLETE', numErrors: 1, errors: [{ message: 'failed' }], results: [] }],
    ['partial response', successfulBatchUpdate(['goal-jan'])],
  ])('does not verify a %s', async (_label, updateResponse) => {
    const previewRequest = vi.fn(async () => batchReadResponse()) as unknown as HubSpotRequestLike;
    const preview = await previewGoalTargetUpdates(updates, previewRequest);
    const request = vi
      .fn()
      .mockResolvedValueOnce(batchReadResponse())
      .mockResolvedValueOnce(updateResponse) as unknown as HubSpotRequestLike;

    const result = await applyGoalTargetUpdates(updates, preview.approvalToken, request);
    expect(result.verified).toBe(false);
    expect(result.verificationPerformed).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
