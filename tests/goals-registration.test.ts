import { describe, expect, it, vi } from 'vitest';
import { ALL_TOOL_NAMES } from '../src/tools/index.js';
import { registerGoalTools } from '../src/tools/goals.js';

describe('goal tool registration', () => {
  it('registers all six goal tools on the MCP server', () => {
    const registerTool = vi.fn();
    registerGoalTools({ registerTool } as never);

    expect(registerTool.mock.calls.map((call) => call[0])).toEqual([
      'hubspot_search_goals',
      'hubspot_get_goal',
      'hubspot_preview_goal_updates',
      'hubspot_batch_update_goals',
      'hubspot_preview_goal_family_create',
      'hubspot_create_goal_family',
    ]);
  });

  it('marks the batch update tool as destructive so MCP hosts require appropriate caution', () => {
    const registerTool = vi.fn();
    registerGoalTools({ registerTool } as never);

    const batchUpdateCall = registerTool.mock.calls.find(
      (call) => call[0] === 'hubspot_batch_update_goals',
    );
    expect(batchUpdateCall?.[1].annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: true,
      }),
    );
  });

  it('marks the family creator as a non-idempotent external mutation', () => {
    const registerTool = vi.fn();
    registerGoalTools({ registerTool } as never);

    const previewCall = registerTool.mock.calls.find(
      (call) => call[0] === 'hubspot_preview_goal_family_create',
    );
    expect(previewCall?.[1].annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      }),
    );

    const createCall = registerTool.mock.calls.find(
      (call) => call[0] === 'hubspot_create_goal_family',
    );
    expect(createCall?.[1].annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      }),
    );
  });

  it('preserves all UI-semantic properties through the create-tool plan schema', () => {
    const registerTool = vi.fn();
    registerGoalTools({ registerTool } as never);
    const createCall = registerTool.mock.calls.find(
      (call) => call[0] === 'hubspot_create_goal_family',
    );
    const semanticProperties = {
      hs_assignee_property_name: 'hubspot_owner_id',
      hs_fiscal_year_offset: '0',
      hs_forecast_type_id: '0',
      hs_goal_target_currency_code: 'USD',
      hs_is_forecastable: 'true',
      hs_kpi_filter_groups: 'filters',
      hs_kpi_filter_groups_for_key_grouping: 'filters',
      hs_kpi_filter_groups_for_key_team_grouping: 'filters',
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
    };
    const planSchema = createCall?.[1].inputSchema.plan as { parse(value: unknown): unknown };
    const parsed = planSchema.parse({
      templateGoalTargetId: '458655189362',
      goalName: '2026 Sales Goal- Max Mejia',
      familyId: '11111111-2222-4333-8444-555555555555',
      targetGroupId: '123456789012345',
      goalType: 'sales_quota',
      milestone: 'monthly',
      assignee: { type: 'owner', id: '41727194' },
      pipelineIds: null,
      notifyOnEdit: false,
      semanticProperties,
      slices: Array.from({ length: 12 }, (_, index) => ({
        start: `2026-${String(index + 1).padStart(2, '0')}-01T00:00:00Z`,
        end: `2026-${String(index + 1).padStart(2, '0')}-28T23:59:59.999Z`,
        targetAmount: '1',
      })),
    }) as { semanticProperties: unknown };

    expect(parsed.semanticProperties).toEqual(semanticProperties);
  });

  it('advertises goal tools in server health and discovery metadata', () => {
    expect(ALL_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        'hubspot_search_goals',
        'hubspot_get_goal',
        'hubspot_preview_goal_updates',
        'hubspot_batch_update_goals',
        'hubspot_preview_goal_family_create',
        'hubspot_create_goal_family',
      ]),
    );
  });
});
