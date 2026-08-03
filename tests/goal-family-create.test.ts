import { describe, expect, it, vi } from 'vitest';
import {
  createGoalFamily,
  formatGoalFamilyCreateToolResult,
  previewGoalFamilyCreate,
  type GoalFamilyCreateDraft,
  type GoalFamilyCreateResult,
  type GoalFamilyIdentifiers,
  type HubSpotGoalFamilyRequestLike,
} from '../src/tools/goal-family-create.js';

function monthEnd(year: number, monthIndex: number): string {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59.999Z`;
}

function twelveSlices(year = 2026) {
  return Array.from({ length: 12 }, (_, monthIndex) => ({
    start: `${year}-${String(monthIndex + 1).padStart(2, '0')}-01T00:00:00Z`,
    end: monthEnd(year, monthIndex),
    targetAmount: String(monthIndex + 1),
  }));
}

const draft: GoalFamilyCreateDraft = {
  templateGoalTargetId: 'template-dec-2025',
  goalName: "Paul's 2026 Sales Goals",
  slices: twelveSlices(),
};

const identifiers: GoalFamilyIdentifiers = {
  familyId: '11111111-2222-4333-8444-555555555555',
  targetGroupId: '123456789012345',
};

function templateResponse(
  updatedAt = '2026-01-01T08:13:37.629Z',
  propertyOverrides: Record<string, string | null> = {},
) {
  return {
    status: 'COMPLETE',
    numErrors: 0,
    errors: [],
    results: [{
      id: 'template-dec-2025',
      properties: {
        hs_goal_name: "Paul's Sales Goals",
        hs_goal_type: 'sales_quota',
        hs_milestone: 'monthly',
        hs_target_amount: '122000.00',
        hs_start_datetime: '2025-12-01T00:00:00Z',
        hs_end_datetime: '2025-12-31T23:59:59.999Z',
        hs_group_correlation_uuid: 'old-family',
        hs_goal_target_group_id: '458592897613',
        hubspot_owner_id: '737980470',
        hs_assignee_team_id: null,
        hubspot_team_id: null,
        hs_pipeline_ids: null,
        hs_should_notify_on_edit_updates: 'false',
        ...propertyOverrides,
      },
      updatedAt,
    }],
  };
}

function noConflictsResponse() {
  return { total: 0, results: [], errors: [], numErrors: 0 };
}

function createdRecordsFor(goalName: string) {
  return draft.slices.map((slice, index) => ({
    id: `new-${String(index + 1).padStart(2, '0')}`,
    properties: {
      hs_goal_name: goalName,
      hs_goal_type: 'sales_quota',
      hs_milestone: 'monthly',
      hs_target_amount: index === 0 ? '1.00' : slice.targetAmount,
      hs_start_datetime: slice.start,
      hs_end_datetime: slice.end,
      hs_group_correlation_uuid: identifiers.familyId,
      hs_goal_target_group_id: identifiers.targetGroupId,
      hubspot_owner_id: '737980470',
      hs_pipeline_ids: null,
      hs_should_notify_on_edit_updates: 'false',
    },
  }));
}

async function previewWith(request: HubSpotGoalFamilyRequestLike) {
  return previewGoalFamilyCreate(draft, request, identifiers);
}

function previewRequest() {
  return vi
    .fn()
    .mockResolvedValueOnce(templateResponse())
    .mockResolvedValueOnce(noConflictsResponse()) as unknown as HubSpotGoalFamilyRequestLike;
}

describe('previewGoalFamilyCreate', () => {
  it('requires and previews one complete 12-target monthly family', async () => {
    const request = previewRequest();
    const preview = await previewWith(request);

    expect(preview.recordCount).toBe(12);
    expect(preview.totalTargetAmount).toBe('78');
    expect(preview.plan.slices).toEqual(draft.slices);
    expect(preview.approvalToken).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(request).toHaveBeenNthCalledWith(2, {
      path: '/crm/v3/objects/goal_targets/search',
      method: 'POST',
      body: expect.objectContaining({
        filterGroups: expect.arrayContaining([
          {
            filters: expect.arrayContaining([
              { propertyName: 'hubspot_owner_id', operator: 'EQ', value: '737980470' },
              { propertyName: 'hs_goal_type', operator: 'EQ', value: 'sales_quota' },
              { propertyName: 'hs_start_datetime', operator: 'LTE', value: draft.slices[11]!.end },
              { propertyName: 'hs_end_datetime', operator: 'GTE', value: draft.slices[0]!.start },
            ]),
          },
          { filters: [{ propertyName: 'hs_group_correlation_uuid', operator: 'EQ', value: identifiers.familyId }] },
          { filters: [{ propertyName: 'hs_goal_target_group_id', operator: 'EQ', value: identifiers.targetGroupId }] },
        ]),
      }),
    });
  });

  it('rejects incomplete monthly families before calling HubSpot', async () => {
    const request = vi.fn() as unknown as HubSpotGoalFamilyRequestLike;
    await expect(previewGoalFamilyCreate({ ...draft, slices: draft.slices.slice(0, 11) }, request, identifiers))
      .rejects.toThrow(/exactly 12/i);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([' 1000', '1000 ', '1e3', '1,000', '-1', '0x10', ''])
  ('rejects non-exact decimal string %j before calling HubSpot', async (targetAmount) => {
    const request = vi.fn() as unknown as HubSpotGoalFamilyRequestLike;
    const badDraft = {
      ...draft,
      slices: draft.slices.map((slice, index) => index === 0 ? { ...slice, targetAmount } : slice),
    };
    await expect(previewGoalFamilyCreate(badDraft, request, identifiers)).rejects.toThrow(/target amount|decimal/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects numeric target inputs before HubSpot', async () => {
    const request = vi.fn() as unknown as HubSpotGoalFamilyRequestLike;
    const badDraft = {
      ...draft,
      slices: draft.slices.map((slice, index) => index === 0 ? { ...slice, targetAmount: 1000 } : slice),
    } as unknown as GoalFamilyCreateDraft;
    await expect(previewGoalFamilyCreate(badDraft, request, identifiers)).rejects.toThrow(/decimal string|numeric/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a gap in the 12-month schedule before HubSpot', async () => {
    const request = vi.fn() as unknown as HubSpotGoalFamilyRequestLike;
    const slices = twelveSlices();
    slices[6] = { ...slices[6]!, start: '2026-08-01T00:00:00Z' };
    await expect(previewGoalFamilyCreate({ ...draft, slices }, request, identifiers))
      .rejects.toThrow(/contiguous|overlap|month/i);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { status: 'PENDING', total: 0, results: [] },
    { total: 0, results: [], numErrors: 1, errors: [{ message: 'search failed' }] },
    { total: 1, results: [] },
  ])('fails closed on malformed or incomplete search response %#', async (searchResponse) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(searchResponse) as unknown as HubSpotGoalFamilyRequestLike;
    await expect(previewWith(request)).rejects.toThrow(/search|conflict|complete|response|overlap/i);
  });

  it('supports the alternate HubSpot team property and searches both team representations', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse(undefined, {
        hubspot_owner_id: null,
        hs_assignee_team_id: null,
        hubspot_team_id: '42',
      }))
      .mockResolvedValueOnce(noConflictsResponse()) as unknown as HubSpotGoalFamilyRequestLike;
    const preview = await previewWith(request);

    expect(preview.plan.assignee).toEqual({ type: 'team', id: '42' });
    const searchCall = (request as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(searchCall.body.filterGroups).toEqual(expect.arrayContaining([
      { filters: expect.arrayContaining([{ propertyName: 'hs_assignee_team_id', operator: 'EQ', value: '42' }]) },
      { filters: expect.arrayContaining([{ propertyName: 'hubspot_team_id', operator: 'EQ', value: '42' }]) },
    ]));
  });
});

describe('createGoalFamily', () => {
  it('creates all 12 approved targets with required empty associations and verifies every property', async () => {
    const preview = await previewWith(previewRequest());
    const createdRecords = createdRecordsFor(preview.plan.goalName);
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce({
        status: 'COMPLETE', numErrors: 0, errors: [],
        results: createdRecords.map(({ id }) => ({ id, properties: {} })),
      })
      .mockResolvedValueOnce({ status: 'COMPLETE', numErrors: 0, errors: [], results: createdRecords }) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    const createCall = (request as ReturnType<typeof vi.fn>).mock.calls[2]![0];

    expect(createCall.path).toBe('/crm/v3/objects/goal_targets/batch/create');
    expect(createCall.body.inputs).toHaveLength(12);
    expect(createCall.body.inputs[0]).toEqual(expect.objectContaining({
      associations: [],
      objectWriteTraceId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      properties: expect.objectContaining({
        hs_target_amount: '1',
        hs_start_datetime: draft.slices[0]!.start,
        hubspot_owner_id: '737980470',
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      verified: true,
      verificationPerformed: true,
      batchSuccessful: true,
      familyId: identifiers.familyId,
      targetGroupId: identifiers.targetGroupId,
      mutationPhase: 'verified',
      reconciliationRequired: false,
    }));
    expect(result.createdIds).toHaveLength(12);
  });

  it('verifies created targets by period instead of trusting response order', async () => {
    const preview = await previewWith(previewRequest());
    const reversed = createdRecordsFor(preview.plan.goalName).reverse();
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce({ status: 'COMPLETE', numErrors: 0, errors: [], results: reversed.map(({ id }) => ({ id })) })
      .mockResolvedValueOnce({ status: 'COMPLETE', numErrors: 0, errors: [], results: reversed }) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    expect(result.verified).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('rejects a stale approval before the write', async () => {
    const preview = await previewWith(previewRequest());
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse('2026-02-01T00:00:00.000Z'))
      .mockResolvedValueOnce(noConflictsResponse()) as unknown as HubSpotGoalFamilyRequestLike;
    await expect(createGoalFamily(preview.plan, preview.approvalToken, request)).rejects.toThrow(/approval token|preview again/i);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns structured reconciliation data for a partial batch response', async () => {
    const preview = await previewWith(previewRequest());
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce({
        status: 'COMPLETE', numErrors: 1, errors: [{ message: 'one target failed' }],
        results: [{ id: 'new-01', properties: {} }],
      }) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    expect(result).toEqual(expect.objectContaining({
      verified: false,
      batchSuccessful: false,
      familyId: identifiers.familyId,
      targetGroupId: identifiers.targetGroupId,
      createdIds: ['new-01'],
      mutationPhase: 'create_response_incomplete',
      reconciliationRequired: true,
    }));
    expect(result.partialCreationRisk).toMatch(/do not retry blindly/i);
  });

  it('returns structured indeterminate data when the create request throws', async () => {
    const preview = await previewWith(previewRequest());
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockRejectedValueOnce(new Error('socket reset after send')) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    expect(result).toEqual(expect.objectContaining({
      verified: false,
      familyId: identifiers.familyId,
      targetGroupId: identifiers.targetGroupId,
      createdIds: [],
      mutationPhase: 'create_request_indeterminate',
      indeterminate: true,
      reconciliationRequired: true,
    }));
    expect(JSON.stringify(result.hubspotErrors)).toMatch(/socket reset after send/);
  });

  it('returns structured reconciliation data for a malformed create response', async () => {
    const preview = await previewWith(previewRequest());
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce(undefined) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    expect(result).toEqual(expect.objectContaining({
      verified: false,
      mutationPhase: 'create_response_incomplete',
      indeterminate: true,
      reconciliationRequired: true,
      familyId: identifiers.familyId,
    }));
  });

  it('blocks a conflict introduced after preview before sending the create request', async () => {
    const preview = await previewWith(previewRequest());
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce({
        total: 1,
        results: [{ id: 'new-conflict', properties: {} }],
        numErrors: 0,
        errors: [],
      }) as unknown as HubSpotGoalFamilyRequestLike;

    await expect(createGoalFamily(preview.plan, preview.approvalToken, request))
      .rejects.toThrow(/approval token|preview again/i);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('preserves known IDs when verification fails after a successful create', async () => {
    const preview = await previewWith(previewRequest());
    const createdRecords = createdRecordsFor(preview.plan.goalName);
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce({
        status: 'COMPLETE', numErrors: 0, errors: [],
        results: createdRecords.map(({ id }) => ({ id })),
      })
      .mockRejectedValueOnce(new Error('verification timeout')) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    expect(result).toEqual(expect.objectContaining({
      verified: false,
      batchSuccessful: true,
      verificationPerformed: false,
      familyId: identifiers.familyId,
      createdIds: createdRecords.map(({ id }) => id),
      mutationPhase: 'verification_indeterminate',
      indeterminate: true,
      reconciliationRequired: true,
    }));
    expect(JSON.stringify(result.hubspotErrors)).toMatch(/verification timeout/);
  });

  it('reports exact verification mismatches as reconciliation-required', async () => {
    const preview = await previewWith(previewRequest());
    const createdRecords = createdRecordsFor(preview.plan.goalName);
    createdRecords[0]!.properties.hs_target_amount = '2';
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce({ status: 'COMPLETE', numErrors: 0, errors: [], results: createdRecords.map(({ id }) => ({ id })) })
      .mockResolvedValueOnce({ status: 'COMPLETE', numErrors: 0, errors: [], results: createdRecords }) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    expect(result).toEqual(expect.objectContaining({
      verified: false,
      mutationPhase: 'verification_failed',
      reconciliationRequired: true,
    }));
    expect(result.mismatches).toContainEqual({
      id: 'new-01', property: 'hs_target_amount', expected: '1', actual: '2',
    });
  });

  it('marks every unverified structured result as an MCP error', () => {
    const result = {
      verified: false,
      verificationPerformed: false,
      batchSuccessful: false,
      approvalToken: 'sha256:' + 'a'.repeat(64),
      familyId: identifiers.familyId,
      targetGroupId: identifiers.targetGroupId,
      createdIds: [],
      mismatches: [],
      hubspotStatus: null,
      hubspotErrors: [],
      mutationPhase: 'create_request_indeterminate',
      indeterminate: true,
      reconciliationRequired: true,
      concurrencyLimitation: 'race warning',
      partialCreationRisk: 'Do not retry blindly.',
    } satisfies GoalFamilyCreateResult;

    const response = formatGoalFamilyCreateToolResult(result, 'json');
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({ familyId: identifiers.familyId }));
  });
});
