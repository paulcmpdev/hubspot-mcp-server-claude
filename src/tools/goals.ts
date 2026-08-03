/**
 * Goal target tools.
 *
 * HubSpot represents one visible goal as multiple time-bound `goal_target`
 * records. Read/search tools expose those records directly. Writes are
 * intentionally limited to target amounts and the edit-notification flag;
 * family-wide metadata changes require a separate, whole-family workflow.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hubspotRequest } from '../services/hubspot-client.js';
import { truncate } from '../services/formatters.js';
import { ResponseFormat } from '../schemas/common.js';
import { toolError, toolResult } from './_helpers.js';
import {
  registerGetTool,
  registerSearchTool,
  type ObjectToolSpec,
} from './_factories.js';

const GOAL_PROPERTIES = [
  'hs_goal_name',
  'hs_goal_type',
  'hs_milestone',
  'hs_target_amount',
  'hs_start_datetime',
  'hs_end_datetime',
  'hs_group_correlation_uuid',
  'hs_goal_target_group_id',
  'hubspot_owner_id',
  'hs_assignee_team_id',
  'hubspot_team_id',
  'hs_pipeline_ids',
  'hs_should_notify_on_edit_updates',
  'hs_createdate',
  'hs_lastmodifieddate',
] as const;

const GOALS: ObjectToolSpec = {
  toolNoun: 'goals',
  singular: 'goal',
  plural: 'goal targets',
  apiPath: 'goal_targets',
  defaultProperties: [...GOAL_PROPERTIES],
  columns: [
    { property: 'hs_goal_name', label: 'goal' },
    { property: 'hubspot_owner_id', label: 'owner' },
    { property: 'hs_start_datetime', label: 'start' },
    { property: 'hs_end_datetime', label: 'end' },
    { property: 'hs_target_amount', label: 'target' },
  ],
  titleProperty: 'hs_goal_name',
};

type RequestMethod = 'GET' | 'POST' | 'PATCH';
interface GoalRequestOptions {
  path: string;
  method?: RequestMethod;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export type HubSpotRequestLike = <T = unknown>(options: GoalRequestOptions) => Promise<T>;

export interface GoalTargetUpdate {
  id: string;
  targetAmount: string | number;
  notifyOnEdit?: boolean;
}

interface GoalTargetRecord {
  id: string;
  properties?: Record<string, string | null>;
  updatedAt?: string;
}

interface BatchGoalResponse {
  status?: string;
  results?: GoalTargetRecord[];
  numErrors?: number;
  errors?: unknown[];
}

interface NormalizedGoalTargetUpdate {
  id: string;
  targetAmount: string;
  notifyOnEdit?: boolean;
}

export interface GoalUpdatePreview {
  approvalToken: string;
  recordCount: number;
  changes: Array<{
    id: string;
    goalName: string | null;
    start: string | null;
    end: string | null;
    before: string | null;
    after: string;
    beforeNotifyOnEdit: string | null;
    afterNotifyOnEdit?: string;
  }>;
}

type VerifiedGoalProperty = 'hs_target_amount' | 'hs_should_notify_on_edit_updates';

export interface GoalUpdateResult {
  verified: boolean;
  verificationPerformed: boolean;
  batchSuccessful: boolean;
  approvalToken: string;
  updatedIds: string[];
  mismatches: Array<{
    id: string;
    property: VerifiedGoalProperty;
    expected: string;
    actual: string | null;
  }>;
  hubspotStatus: string | null;
  hubspotErrors: unknown[];
  concurrencyLimitation: string;
}

const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/;

function normalizeUpdates(updates: GoalTargetUpdate[]): NormalizedGoalTargetUpdate[] {
  if (updates.length === 0) throw new Error('At least one goal target update is required.');
  if (updates.length > 100) throw new Error('HubSpot batch operations accept at most 100 goal targets.');

  const seen = new Set<string>();
  const normalized = updates.map((update) => {
    const id = update.id.trim();
    if (!id) throw new Error('Every goal target update requires a non-empty ID.');
    if (seen.has(id)) throw new Error(`Duplicate goal target ID: ${id}`);
    seen.add(id);

    const targetAmount = typeof update.targetAmount === 'number'
      ? String(update.targetAmount)
      : update.targetAmount.trim();
    if (!DECIMAL_AMOUNT.test(targetAmount)) {
      throw new Error(`Invalid target amount for goal target ${id}: ${update.targetAmount}`);
    }

    return {
      id,
      targetAmount,
      ...(update.notifyOnEdit === undefined ? {} : { notifyOnEdit: update.notifyOnEdit }),
    };
  });

  return normalized;
}

async function readGoalTargets(
  updates: NormalizedGoalTargetUpdate[],
  request: HubSpotRequestLike,
): Promise<GoalTargetRecord[]> {
  const response = await request<BatchGoalResponse>({
    path: '/crm/v3/objects/goal_targets/batch/read',
    method: 'POST',
    body: {
      properties: [...GOAL_PROPERTIES],
      propertiesWithHistory: [],
      inputs: updates.map(({ id }) => ({ id })),
    },
  });

  if (!response || response.status !== 'COMPLETE') {
    throw new Error(`HubSpot batch read did not complete (status: ${response?.status ?? 'missing'}).`);
  }
  if ((response.numErrors ?? 0) > 0 || (response.errors?.length ?? 0) > 0) {
    throw new Error(`HubSpot batch read returned errors: ${JSON.stringify(response.errors ?? [])}`);
  }

  const records = response.results ?? [];
  const found = new Set(records.map((record) => record.id));
  const missing = updates.map(({ id }) => id).filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`HubSpot did not return goal target ID(s): ${missing.join(', ')}`);
  }
  return records;
}

function approvalTokenFor(
  updates: NormalizedGoalTargetUpdate[],
  records: GoalTargetRecord[],
): string {
  const current = new Map(records.map((record) => [record.id, record]));
  const boundPlan = [...updates]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((update) => {
      const record = current.get(update.id)!;
      return {
        id: update.id,
        targetAmount: update.targetAmount,
        ...(update.notifyOnEdit === undefined ? {} : { notifyOnEdit: update.notifyOnEdit }),
        currentTargetAmount: record.properties?.hs_target_amount ?? null,
        currentNotifyOnEdit: record.properties?.hs_should_notify_on_edit_updates ?? null,
        updatedAt: record.updatedAt ?? record.properties?.hs_lastmodifieddate ?? null,
      };
    });
  const digest = createHash('sha256').update(JSON.stringify(boundPlan)).digest('hex');
  return `sha256:${digest}`;
}

export async function previewGoalTargetUpdates(
  updates: GoalTargetUpdate[],
  request: HubSpotRequestLike = hubspotRequest,
): Promise<GoalUpdatePreview> {
  const normalized = normalizeUpdates(updates);
  const records = await readGoalTargets(normalized, request);
  const current = new Map(records.map((record) => [record.id, record]));

  return {
    approvalToken: approvalTokenFor(normalized, records),
    recordCount: normalized.length,
    changes: normalized.map((update) => {
      const record = current.get(update.id)!;
      return {
        id: update.id,
        goalName: record.properties?.hs_goal_name ?? null,
        start: record.properties?.hs_start_datetime ?? null,
        end: record.properties?.hs_end_datetime ?? null,
        before: record.properties?.hs_target_amount ?? null,
        after: update.targetAmount,
        beforeNotifyOnEdit: record.properties?.hs_should_notify_on_edit_updates ?? null,
        ...(update.notifyOnEdit === undefined
          ? {}
          : { afterNotifyOnEdit: String(update.notifyOnEdit) }),
      };
    }),
  };
}

function canonicalDecimal(value: string): string | null {
  if (!DECIMAL_AMOUNT.test(value)) return null;
  const [rawInteger, rawFraction = ''] = value.split('.');
  const integer = rawInteger!.replace(/^0+(?=\d)/, '');
  const fraction = rawFraction.replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function targetAmountsEqual(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const canonicalExpected = canonicalDecimal(expected);
  const canonicalActual = canonicalDecimal(actual);
  return canonicalExpected !== null && canonicalExpected === canonicalActual;
}

export async function applyGoalTargetUpdates(
  updates: GoalTargetUpdate[],
  approvalToken: string,
  request: HubSpotRequestLike = hubspotRequest,
): Promise<GoalUpdateResult> {
  const normalized = normalizeUpdates(updates);
  const current = await readGoalTargets(normalized, request);
  const expectedToken = approvalTokenFor(normalized, current);
  if (approvalToken !== expectedToken) {
    throw new Error(
      'Approval token does not match the current HubSpot state and exact update payload. ' +
      'Run hubspot_preview_goal_updates again and approve the new preview.',
    );
  }

  const updateResponse = await request<BatchGoalResponse>({
    path: '/crm/v3/objects/goal_targets/batch/update',
    method: 'POST',
    body: {
      inputs: normalized.map((update) => ({
        id: update.id,
        properties: {
          hs_target_amount: update.targetAmount,
          ...(update.notifyOnEdit === undefined
            ? {}
            : { hs_should_notify_on_edit_updates: String(update.notifyOnEdit) }),
        },
      })),
    },
  });

  const resultIds = updateResponse?.results?.map((record) => record.id) ?? [];
  const resultIdSet = new Set(resultIds);
  const hubspotErrors = updateResponse?.errors ?? [];
  const batchSuccessful = Boolean(
    updateResponse &&
    updateResponse.status === 'COMPLETE' &&
    (updateResponse.numErrors ?? hubspotErrors.length) === 0 &&
    hubspotErrors.length === 0 &&
    normalized.every(({ id }) => resultIdSet.has(id)),
  );
  const concurrencyLimitation =
    'HubSpot does not support conditional goal-target writes. The approval token confirms only the ' +
    'state observed by the final pre-write read. State can change after that read, before or during the ' +
    'update, and around the follow-up read. Verification confirms only the state observed by that ' +
    'follow-up read; it cannot eliminate concurrent-write races.';

  if (!batchSuccessful) {
    return {
      verified: false,
      verificationPerformed: false,
      batchSuccessful: false,
      approvalToken,
      updatedIds: resultIds,
      mismatches: [],
      hubspotStatus: updateResponse?.status ?? null,
      hubspotErrors,
      concurrencyLimitation,
    };
  }

  const finalRecords = await readGoalTargets(normalized, request);
  const finalById = new Map(finalRecords.map((record) => [record.id, record]));
  const mismatches: GoalUpdateResult['mismatches'] = [];
  for (const update of normalized) {
    const properties = finalById.get(update.id)?.properties;
    const actualAmount = properties?.hs_target_amount ?? null;
    if (!targetAmountsEqual(update.targetAmount, actualAmount)) {
      mismatches.push({
        id: update.id,
        property: 'hs_target_amount',
        expected: update.targetAmount,
        actual: actualAmount,
      });
    }
    if (update.notifyOnEdit !== undefined) {
      const expectedNotification = String(update.notifyOnEdit);
      const actualNotification = properties?.hs_should_notify_on_edit_updates ?? null;
      if (actualNotification !== expectedNotification) {
        mismatches.push({
          id: update.id,
          property: 'hs_should_notify_on_edit_updates',
          expected: expectedNotification,
          actual: actualNotification,
        });
      }
    }
  }

  return {
    verified: mismatches.length === 0,
    verificationPerformed: true,
    batchSuccessful: true,
    approvalToken,
    updatedIds: resultIds,
    mismatches,
    hubspotStatus: updateResponse.status ?? null,
    hubspotErrors,
    concurrencyLimitation,
  };
}

const GoalUpdateInput = z.object({
  id: z.string().min(1).describe('Internal HubSpot goal target ID.'),
  targetAmount: z.union([z.string().min(1), z.number().finite().nonnegative()])
    .describe('New target amount. Numeric strings preserve decimal formatting.'),
  notifyOnEdit: z.boolean().optional()
    .describe('Set HubSpot\'s edit-notification flag for this target.'),
});

function previewMarkdown(preview: GoalUpdatePreview): string {
  return [
    '## Goal update preview',
    '',
    `Approval token: \`${preview.approvalToken}\``,
    '',
    '| Target ID | Goal | Period | Before | After | Notify before | Notify after |',
    '| --- | --- | --- | ---: | ---: | --- | --- |',
    ...preview.changes.map((change) =>
      `| ${change.id} | ${change.goalName ?? '—'} | ${change.start ?? '—'} → ${change.end ?? '—'} | ${change.before ?? '—'} | ${change.after} | ${change.beforeNotifyOnEdit ?? '—'} | ${change.afterNotifyOnEdit ?? 'unchanged'} |`,
    ),
    '',
    '_No changes were made. Pass this exact update payload and approval token to `hubspot_batch_update_goals` after approval._',
  ].join('\n');
}

export function registerGoalTools(server: McpServer): void {
  registerSearchTool(server, GOALS);
  registerGetTool(server, GOALS);

  server.registerTool(
    'hubspot_preview_goal_updates',
    {
      title: 'Preview goal target amount updates',
      description:
        'Read current HubSpot goal targets and produce an exact before/after preview plus a state-bound ' +
        'approval token. This tool is read-only and must be called before hubspot_batch_update_goals.',
      inputSchema: {
        updates: z.array(GoalUpdateInput).min(1).max(100),
        response_format: ResponseFormat,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const preview = await previewGoalTargetUpdates(args.updates);
        return args.response_format === 'json'
          ? toolResult(truncate(JSON.stringify(preview, null, 2)), preview)
          : toolResult(truncate(previewMarkdown(preview)), preview);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'hubspot_batch_update_goals',
    {
      title: 'Apply approved goal target amount updates',
      description:
        'Update up to 100 existing HubSpot goal target amounts in one batch. Requires the exact payload ' +
        'and state-bound approval token returned by hubspot_preview_goal_updates. Re-reads every target ' +
        'immediately before writing and rejects the update when that observed state differs from the approved ' +
        'preview. A follow-up read confirms the state observed at verification time. HubSpot does not support ' +
        'conditional goal-target writes, so state can still change after either read. This tool ' +
        'does not rename goals or change family-level metadata.',
      inputSchema: {
        updates: z.array(GoalUpdateInput).min(1).max(100),
        approvalToken: z.string().regex(/^sha256:[a-f0-9]{64}$/)
          .describe('Exact token returned by hubspot_preview_goal_updates for this payload.'),
        response_format: ResponseFormat,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await applyGoalTargetUpdates(args.updates, args.approvalToken);
        const text = result.verified
          ? `Updated and verified ${result.updatedIds.length} HubSpot goal target(s): ${result.updatedIds.join(', ')}`
          : result.verificationPerformed
            ? `HubSpot completed the batch, but verification failed: ${JSON.stringify(result.mismatches)}`
            : `HubSpot batch was not fully successful and was not verified (status: ${result.hubspotStatus}, errors: ${JSON.stringify(result.hubspotErrors)}).`;
        return toolResult(
          args.response_format === 'json' ? truncate(JSON.stringify(result, null, 2)) : text,
          result,
        );
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
