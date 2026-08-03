import { describe, expect, it, vi } from 'vitest';
import { ALL_TOOL_NAMES } from '../src/tools/index.js';
import { registerGoalTools } from '../src/tools/goals.js';

describe('goal tool registration', () => {
  it('registers all four goal tools on the MCP server', () => {
    const registerTool = vi.fn();
    registerGoalTools({ registerTool } as never);

    expect(registerTool.mock.calls.map((call) => call[0])).toEqual([
      'hubspot_search_goals',
      'hubspot_get_goal',
      'hubspot_preview_goal_updates',
      'hubspot_batch_update_goals',
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

  it('advertises goal tools in server health and discovery metadata', () => {
    expect(ALL_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        'hubspot_search_goals',
        'hubspot_get_goal',
        'hubspot_preview_goal_updates',
        'hubspot_batch_update_goals',
      ]),
    );
  });
});
