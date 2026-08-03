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

const semanticTemplateProperties = {
  hs_assignee_property_name: 'hubspot_owner_id',
  hs_fiscal_year_offset: '0',
  hs_forecast_type_id: '0',
  hs_goal_target_currency_code: 'USD',
  hs_is_forecastable: 'true',
  hs_kpi_filter_groups: '[{"filters":[{"value":"true","property":"hs_is_closed_won","operator":"EQ"}]}]',
  hs_kpi_filter_groups_for_key_grouping: '[{"filters":[{"value":"true","property":"hs_is_closed_won","operator":"EQ"}]}]',
  hs_kpi_filter_groups_for_key_team_grouping: '[{"filters":[{"value":"true","property":"hs_is_closed_won","operator":"EQ"}]}]',
  hs_kpi_is_team_rollup: 'false',
  hs_kpi_metric_type: 'SUM',
  hs_kpi_object_type_id: '0-3',
  hs_kpi_property_name: 'amount_in_home_currency',
  hs_kpi_single_object_custom_goal_type_name: 'sum_amount_in_home_currency_0-3',
  hs_kpi_time_period_property: 'closedate',
  hs_kpi_time_period_property_type: 'datetime',
  hs_kpi_tracking_method: 'HIGHER_IS_BETTER',
  hs_kpi_unit_type: 'currency',
  hs_template_id: '30',
} as const;

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
        ...semanticTemplateProperties,
        ...propertyOverrides,
      },
      updatedAt,
    }],
  };
}

function noConflictsResponse() {
  return { total: 0, results: [], errors: [], numErrors: 0 };
}

function createdRecordsFor(
  goalName: string,
  assigneeProperty = 'hubspot_owner_id',
  assigneeId = '737980470',
  semanticOverrides: Partial<Record<keyof typeof semanticTemplateProperties, string>> = {},
) {
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
      hs_pipeline_ids: null,
      hs_should_notify_on_edit_updates: 'false',
      ...semanticTemplateProperties,
      ...semanticOverrides,
      [assigneeProperty]: assigneeId,
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
    expect(preview.plan.semanticProperties).toEqual(semanticTemplateProperties);
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
        hs_assignee_property_name: 'hubspot_team_id',
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

  it('rejects templates missing UI-semantic goal-definition properties', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse(undefined, { hs_template_id: null })) as unknown as HubSpotGoalFamilyRequestLike;

    await expect(previewWith(request)).rejects.toThrow(/semantic|template|hs_template_id/i);
    expect(request).toHaveBeenCalledTimes(1);
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
        ...semanticTemplateProperties,
      }),
    }));
    expect(Object.keys(createCall.body.inputs[0].properties).sort()).toEqual([
      ...Object.keys(semanticTemplateProperties),
      'hs_goal_name',
      'hs_goal_type',
      'hs_milestone',
      'hs_target_amount',
      'hs_start_datetime',
      'hs_end_datetime',
      'hs_group_correlation_uuid',
      'hs_goal_target_group_id',
      'hubspot_owner_id',
      'hs_should_notify_on_edit_updates',
    ].sort());
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

  it('writes a team assignee through the semantic assignee property copied from the template', async () => {
    const teamOverrides = {
      hubspot_owner_id: null,
      hs_assignee_team_id: null,
      hubspot_team_id: '42',
      hs_assignee_property_name: 'hubspot_team_id',
    };
    const previewRequest = vi
      .fn()
      .mockResolvedValueOnce(templateResponse(undefined, teamOverrides))
      .mockResolvedValueOnce(noConflictsResponse()) as unknown as HubSpotGoalFamilyRequestLike;
    const preview = await previewWith(previewRequest);
    const createdRecords = createdRecordsFor(
      preview.plan.goalName,
      'hubspot_team_id',
      '42',
      { hs_assignee_property_name: 'hubspot_team_id' },
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse(undefined, teamOverrides))
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce({
        status: 'COMPLETE', numErrors: 0, errors: [],
        results: createdRecords.map(({ id }) => ({ id })),
      })
      .mockResolvedValueOnce({ status: 'COMPLETE', numErrors: 0, errors: [], results: createdRecords }) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    const createCall = (request as ReturnType<typeof vi.fn>).mock.calls[2]![0];

    expect(createCall.body.inputs[0].properties).toEqual(expect.objectContaining({
      hs_assignee_property_name: 'hubspot_team_id',
      hubspot_team_id: '42',
    }));
    expect(createCall.body.inputs[0].properties).not.toHaveProperty('hs_assignee_team_id');
    expect(result.verified).toBe(true);
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

  it('treats equivalent ISO timestamp representations as the same period', async () => {
    const preview = await previewWith(previewRequest());
    const normalized = createdRecordsFor(preview.plan.goalName).map((record) => ({
      ...record,
      properties: {
        ...record.properties,
        hs_start_datetime: record.properties.hs_start_datetime.replace('T00:00:00Z', 'T00:00:00.000Z'),
        hs_end_datetime: record.properties.hs_end_datetime.replace('Z', '+00:00'),
      },
    }));
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce({ status: 'COMPLETE', numErrors: 0, errors: [], results: normalized.map(({ id }) => ({ id })) })
      .mockResolvedValueOnce({ status: 'COMPLETE', numErrors: 0, errors: [], results: normalized }) as unknown as HubSpotGoalFamilyRequestLike;

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

  it('rejects approval when a semantic template property changes before the write', async () => {
    const preview = await previewWith(previewRequest());
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse(undefined, { hs_template_id: '31' }))
      .mockResolvedValueOnce(noConflictsResponse()) as unknown as HubSpotGoalFamilyRequestLike;

    await expect(createGoalFamily(preview.plan, preview.approvalToken, request))
      .rejects.toThrow(/plan no longer matches|preview again|approval token/i);
    expect(request).toHaveBeenCalledTimes(1);
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
      indeterminate: true,
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

  it('returns structured reconciliation data for malformed result elements after create', async () => {
    const preview = await previewWith(previewRequest());
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce({
        status: 'COMPLETE', numErrors: 0, errors: [], results: [null],
      }) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    expect(result).toEqual(expect.objectContaining({
      verified: false,
      createdIds: [],
      mutationPhase: 'create_response_incomplete',
      indeterminate: true,
      reconciliationRequired: true,
    }));
    expect(JSON.stringify(result.hubspotErrors)).toMatch(/malformed|result|id/i);
  });

  it('returns structured reconciliation data for a malformed errors collection after create', async () => {
    const preview = await previewWith(previewRequest());
    const createdRecords = createdRecordsFor(preview.plan.goalName);
    const request = vi
      .fn()
      .mockResolvedValueOnce(templateResponse())
      .mockResolvedValueOnce(noConflictsResponse())
      .mockResolvedValueOnce({
        status: 'COMPLETE',
        numErrors: 0,
        errors: { message: 'malformed errors collection' },
        results: createdRecords.map(({ id }) => ({ id })),
      }) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    expect(result).toEqual(expect.objectContaining({
      verified: false,
      createdIds: createdRecords.map(({ id }) => id),
      mutationPhase: 'create_response_incomplete',
      indeterminate: true,
      reconciliationRequired: true,
    }));
    expect(JSON.stringify(result.hubspotErrors)).toMatch(/malformed|errors|array/i);
    expect(request).toHaveBeenCalledTimes(3);
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

  it('fails closed on a malformed verification errors collection', async () => {
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
      .mockResolvedValueOnce({
        status: 'COMPLETE',
        numErrors: 0,
        errors: { message: 'malformed verification errors collection' },
        results: createdRecords,
      }) as unknown as HubSpotGoalFamilyRequestLike;

    const result = await createGoalFamily(preview.plan, preview.approvalToken, request);
    expect(result).toEqual(expect.objectContaining({
      verified: false,
      batchSuccessful: true,
      verificationPerformed: false,
      createdIds: createdRecords.map(({ id }) => id),
      mutationPhase: 'verification_indeterminate',
      indeterminate: true,
      reconciliationRequired: true,
    }));
    expect(JSON.stringify(result.hubspotErrors)).toMatch(/malformed|errors|array|verification/i);
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

  it('reports exact semantic-property verification mismatches', async () => {
    const preview = await previewWith(previewRequest());
    const createdRecords = createdRecordsFor(preview.plan.goalName);
    createdRecords[0]!.properties.hs_template_id = '31';
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
      id: 'new-01', property: 'hs_template_id', expected: '30', actual: '31',
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
