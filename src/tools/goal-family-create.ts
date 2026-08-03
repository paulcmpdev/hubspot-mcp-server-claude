/**
 * Guarded creation of whole HubSpot goal families.
 *
 * A visible HubSpot goal is a family of time-bound `goal_target` records. This
 * module creates complete, template-based families only. It never deletes or
 * mutates the source template.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { hubspotRequest } from '../services/hubspot-client.js';
import { truncate } from '../services/formatters.js';
import { ResponseFormat } from '../schemas/common.js';
import { toolError, toolResult } from './_helpers.js';

export type GoalFamilyRequestMethod = 'GET' | 'POST' | 'PATCH';
export interface GoalFamilyRequestOptions {
  path: string;
  method?: GoalFamilyRequestMethod;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export type HubSpotGoalFamilyRequestLike = <T = unknown>(
  options: GoalFamilyRequestOptions,
) => Promise<T>;

export interface GoalFamilySliceInput {
  start: string;
  end: string;
  targetAmount: string;
}

export interface GoalFamilyCreateDraft {
  templateGoalTargetId: string;
  goalName: string;
  slices: GoalFamilySliceInput[];
  notifyOnEdit?: boolean;
}

export interface GoalFamilyIdentifiers {
  familyId: string;
  targetGroupId: string;
}

interface NormalizedGoalFamilySlice {
  start: string;
  end: string;
  targetAmount: string;
}

export interface GoalFamilyCreatePlan {
  templateGoalTargetId: string;
  goalName: string;
  familyId: string;
  targetGroupId: string;
  goalType: string;
  milestone: 'monthly';
  assignee: { type: 'owner' | 'team'; id: string };
  pipelineIds: string | null;
  notifyOnEdit: boolean;
  semanticProperties: SemanticTemplateProperties;
  slices: NormalizedGoalFamilySlice[];
}

export interface GoalFamilyCreatePreview {
  approvalToken: string;
  plan: GoalFamilyCreatePlan;
  recordCount: number;
  totalTargetAmount: string;
  conflictingTargetIds: string[];
  template: {
    id: string;
    goalName: string | null;
    updatedAt: string | null;
  };
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

interface SearchGoalResponse {
  status?: string;
  total?: number;
  results?: GoalTargetRecord[];
  numErrors?: number;
  errors?: unknown[];
}

const SEMANTIC_TEMPLATE_PROPERTIES = [
  'hs_assignee_property_name',
  'hs_fiscal_year_offset',
  'hs_forecast_type_id',
  'hs_goal_target_currency_code',
  'hs_is_forecastable',
  'hs_kpi_filter_groups',
  'hs_kpi_filter_groups_for_key_grouping',
  'hs_kpi_filter_groups_for_key_team_grouping',
  'hs_kpi_is_team_rollup',
  'hs_kpi_metric_type',
  'hs_kpi_object_type_id',
  'hs_kpi_property_name',
  'hs_kpi_single_object_custom_goal_type_name',
  'hs_kpi_time_period_property',
  'hs_kpi_time_period_property_type',
  'hs_kpi_tracking_method',
  'hs_kpi_unit_type',
  'hs_template_id',
] as const;

type SemanticTemplateProperty = (typeof SEMANTIC_TEMPLATE_PROPERTIES)[number];
type SemanticTemplateProperties = Record<SemanticTemplateProperty, string>;

const TEMPLATE_PROPERTIES = [
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
  ...SEMANTIC_TEMPLATE_PROPERTIES,
  'hs_lastmodifieddate',
] as const;

const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^\d+$/;
const MONTH_START = /^\d{4}-\d{2}-01T00:00:00(?:\.000)?Z$/;
const MONTH_END = /^\d{4}-\d{2}-\d{2}T23:59:59\.999Z$/;

function canonicalDecimal(value: string): string {
  if (!DECIMAL_AMOUNT.test(value)) throw new Error(`Invalid decimal amount: ${value}`);
  const [rawInteger, rawFraction = ''] = value.split('.');
  const integer = rawInteger!.replace(/^0+(?=\d)/, '');
  const fraction = rawFraction.replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function addDecimals(values: string[]): string {
  const parts = values.map((value) => {
    const canonical = canonicalDecimal(value);
    const [integer, fraction = ''] = canonical.split('.');
    return { integer: integer!, fraction };
  });
  const scale = Math.max(0, ...parts.map(({ fraction }) => fraction.length));
  const total = parts.reduce((sum, { integer, fraction }) => {
    return sum + BigInt(integer + fraction.padEnd(scale, '0'));
  }, 0n);
  if (scale === 0) return total.toString();
  const padded = total.toString().padStart(scale + 1, '0');
  const integer = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function lastDayOfUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function validateAndNormalizeSlices(slices: GoalFamilySliceInput[]): NormalizedGoalFamilySlice[] {
  if (slices.length !== 12) {
    throw new Error('A monthly HubSpot goal family requires exactly 12 contiguous monthly target slices.');
  }

  const normalized = slices.map((slice, index) => {
    const start = slice.start.trim();
    const end = slice.end.trim();
    if (typeof slice.targetAmount !== 'string') {
      throw new Error(`Slice ${index + 1} target amount must be an exact decimal string; numeric inputs are rejected.`);
    }
    if (!DECIMAL_AMOUNT.test(slice.targetAmount)) {
      throw new Error(`Invalid target amount for slice ${index + 1}: ${slice.targetAmount}`);
    }
    const targetAmount = slice.targetAmount;
    if (!MONTH_START.test(start) || !MONTH_END.test(end)) {
      throw new Error(`Slice ${index + 1} must use exact UTC month boundaries.`);
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.valueOf()) || Number.isNaN(endDate.valueOf())) {
      throw new Error(`Slice ${index + 1} contains an invalid date.`);
    }
    if (
      startDate.getUTCFullYear() !== endDate.getUTCFullYear() ||
      startDate.getUTCMonth() !== endDate.getUTCMonth() ||
      endDate.getUTCDate() !== lastDayOfUtcMonth(startDate.getUTCFullYear(), startDate.getUTCMonth())
    ) {
      throw new Error(`Slice ${index + 1} must begin and end in the same complete UTC month.`);
    }

    if (index > 0) {
      const previous = new Date(slices[index - 1]!.start.trim());
      const expected = new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth() + 1, 1));
      if (startDate.valueOf() !== expected.valueOf()) {
        throw new Error('Monthly goal slices must be chronological, contiguous, and non-overlapping.');
      }
    }
    return { start, end, targetAmount };
  });

  return normalized;
}

function normalizeDraft(draft: GoalFamilyCreateDraft): Omit<GoalFamilyCreateDraft, 'slices'> & {
  slices: NormalizedGoalFamilySlice[];
} {
  const templateGoalTargetId = draft.templateGoalTargetId.trim();
  const goalName = draft.goalName.trim();
  if (!templateGoalTargetId) throw new Error('A template goal target ID is required.');
  if (!goalName) throw new Error('A goal name is required.');
  return {
    templateGoalTargetId,
    goalName,
    slices: validateAndNormalizeSlices(draft.slices),
    ...(draft.notifyOnEdit === undefined ? {} : { notifyOnEdit: draft.notifyOnEdit }),
  };
}

function generateIdentifiers(): GoalFamilyIdentifiers {
  const random = BigInt(`0x${randomBytes(8).toString('hex')}`);
  const targetGroupId = (100_000_000_000_000n + (random % 900_000_000_000_000n)).toString();
  return { familyId: randomUUID(), targetGroupId };
}

function validateIdentifiers(identifiers: GoalFamilyIdentifiers): void {
  if (!UUID_V4.test(identifiers.familyId)) throw new Error('familyId must be a UUID v4.');
  if (!NUMERIC_ID.test(identifiers.targetGroupId)) throw new Error('targetGroupId must be numeric.');
}

async function readTemplate(
  templateGoalTargetId: string,
  request: HubSpotGoalFamilyRequestLike,
): Promise<GoalTargetRecord> {
  const response = await request<BatchGoalResponse>({
    path: '/crm/v3/objects/goal_targets/batch/read',
    method: 'POST',
    body: {
      properties: [...TEMPLATE_PROPERTIES],
      propertiesWithHistory: [],
      inputs: [{ id: templateGoalTargetId }],
    },
  });
  if (!response || response.status !== 'COMPLETE') {
    throw new Error(`HubSpot template read did not complete (status: ${response?.status ?? 'missing'}).`);
  }
  if ((response.numErrors ?? 0) > 0 || (response.errors?.length ?? 0) > 0) {
    throw new Error(`HubSpot template read returned errors: ${JSON.stringify(response.errors ?? [])}`);
  }
  const matches = (response.results ?? []).filter(({ id }) => id === templateGoalTargetId);
  if (matches.length !== 1) throw new Error(`HubSpot did not return template goal target ${templateGoalTargetId}.`);
  return matches[0]!;
}

function semanticPropertiesFromTemplate(
  properties: Record<string, string | null>,
): SemanticTemplateProperties {
  const entries = SEMANTIC_TEMPLATE_PROPERTIES.map((property) => {
    const value = properties[property]?.trim();
    if (!value) {
      throw new Error(`The template goal is missing required UI-semantic property ${property}.`);
    }
    return [property, value] as const;
  });
  return Object.fromEntries(entries) as SemanticTemplateProperties;
}

function planFromTemplate(
  draft: ReturnType<typeof normalizeDraft>,
  template: GoalTargetRecord,
  identifiers: GoalFamilyIdentifiers,
): GoalFamilyCreatePlan {
  const properties = template.properties ?? {};
  if (properties.hs_milestone !== 'monthly') {
    throw new Error('The template goal must use the monthly milestone.');
  }
  const goalType = properties.hs_goal_type?.trim();
  if (!goalType) throw new Error('The template goal is missing hs_goal_type.');

  const ownerId = properties.hubspot_owner_id?.trim();
  const writableTeamId = properties.hs_assignee_team_id?.trim();
  const alternateTeamId = properties.hubspot_team_id?.trim();
  if (writableTeamId && alternateTeamId && writableTeamId !== alternateTeamId) {
    throw new Error('The template goal contains conflicting HubSpot team assignee IDs.');
  }
  const teamId = writableTeamId ?? alternateTeamId;
  if (Boolean(ownerId) === Boolean(teamId)) {
    throw new Error('The template goal must have exactly one writable owner or team assignee.');
  }

  const templateNotify = properties.hs_should_notify_on_edit_updates;
  if (templateNotify !== 'true' && templateNotify !== 'false') {
    throw new Error('The template goal has an invalid edit-notification state.');
  }

  const semanticProperties = semanticPropertiesFromTemplate(properties);
  const assigneeProperty = semanticProperties.hs_assignee_property_name;
  if (ownerId && assigneeProperty !== 'hubspot_owner_id') {
    throw new Error('The template goal semantic assignee property does not match its owner assignment.');
  }
  if (teamId && assigneeProperty !== 'hs_assignee_team_id' && assigneeProperty !== 'hubspot_team_id') {
    throw new Error('The template goal semantic assignee property does not match its team assignment.');
  }

  return {
    templateGoalTargetId: draft.templateGoalTargetId,
    goalName: draft.goalName,
    familyId: identifiers.familyId,
    targetGroupId: identifiers.targetGroupId,
    goalType,
    milestone: 'monthly',
    assignee: ownerId
      ? { type: 'owner', id: ownerId }
      : { type: 'team', id: teamId! },
    pipelineIds: properties.hs_pipeline_ids ?? null,
    notifyOnEdit: draft.notifyOnEdit ?? templateNotify === 'true',
    semanticProperties,
    slices: draft.slices,
  };
}

async function findConflicts(
  plan: GoalFamilyCreatePlan,
  request: HubSpotGoalFamilyRequestLike,
): Promise<GoalTargetRecord[]> {
  const response = await request<SearchGoalResponse>({
    path: '/crm/v3/objects/goal_targets/search',
    method: 'POST',
    body: {
      filterGroups: [
        ...(plan.assignee.type === 'owner'
          ? [{ filters: [
              { propertyName: 'hubspot_owner_id', operator: 'EQ', value: plan.assignee.id },
              { propertyName: 'hs_goal_type', operator: 'EQ', value: plan.goalType },
              { propertyName: 'hs_start_datetime', operator: 'LTE', value: plan.slices.at(-1)!.end },
              { propertyName: 'hs_end_datetime', operator: 'GTE', value: plan.slices[0]!.start },
            ] }]
          : ['hs_assignee_team_id', 'hubspot_team_id'].map((propertyName) => ({ filters: [
              { propertyName, operator: 'EQ', value: plan.assignee.id },
              { propertyName: 'hs_goal_type', operator: 'EQ', value: plan.goalType },
              { propertyName: 'hs_start_datetime', operator: 'LTE', value: plan.slices.at(-1)!.end },
              { propertyName: 'hs_end_datetime', operator: 'GTE', value: plan.slices[0]!.start },
            ] }))),
        {
          filters: [
            { propertyName: 'hs_group_correlation_uuid', operator: 'EQ', value: plan.familyId },
          ],
        },
        {
          filters: [
            { propertyName: 'hs_goal_target_group_id', operator: 'EQ', value: plan.targetGroupId },
          ],
        },
      ],
      properties: [...TEMPLATE_PROPERTIES],
      limit: 100,
      sorts: ['hs_start_datetime'],
      after: 0,
    },
  });
  if (!response || (response.status !== undefined && response.status !== 'COMPLETE')) {
    throw new Error(`HubSpot conflict search did not complete (status: ${response?.status ?? 'missing response'}).`);
  }
  if ((response.numErrors ?? 0) > 0 || (response.errors?.length ?? 0) > 0) {
    throw new Error(`HubSpot conflict search returned errors: ${JSON.stringify(response.errors ?? [])}`);
  }
  if (!Number.isInteger(response.total) || response.total! < 0 || !Array.isArray(response.results)) {
    throw new Error('HubSpot conflict search returned a malformed response without explicit total and results.');
  }
  const results = response.results;
  const total = response.total as number;
  if (total < results.length || (total > 0 && results.length === 0)) {
    throw new Error(
      `HubSpot overlap search returned an incomplete result set (total: ${total}, results: ${results.length}).`,
    );
  }
  return results;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function approvalTokenFor(
  plan: GoalFamilyCreatePlan,
  template: GoalTargetRecord,
  conflictingTargetIds: string[],
): string {
  const boundPlan = {
    plan,
    template: {
      id: template.id,
      properties: template.properties ?? {},
      updatedAt: template.updatedAt ?? template.properties?.hs_lastmodifieddate ?? null,
    },
    conflictingTargetIds: [...conflictingTargetIds].sort(),
  };
  return `sha256:${createHash('sha256').update(canonicalJson(boundPlan)).digest('hex')}`;
}

export async function previewGoalFamilyCreate(
  draft: GoalFamilyCreateDraft,
  request: HubSpotGoalFamilyRequestLike = hubspotRequest,
  suppliedIdentifiers?: GoalFamilyIdentifiers,
): Promise<GoalFamilyCreatePreview> {
  const normalizedDraft = normalizeDraft(draft);
  const identifiers = suppliedIdentifiers ?? generateIdentifiers();
  validateIdentifiers(identifiers);
  const template = await readTemplate(normalizedDraft.templateGoalTargetId, request);
  const plan = planFromTemplate(normalizedDraft, template, identifiers);
  const conflicts = await findConflicts(plan, request);
  const conflictingTargetIds = conflicts.map(({ id }) => id);
  if (conflictingTargetIds.length > 0) {
    throw new Error(
      `Existing ${plan.goalType} goal targets overlap the requested period: ${conflictingTargetIds.join(', ')}`,
    );
  }

  return {
    approvalToken: approvalTokenFor(plan, template, conflictingTargetIds),
    plan,
    recordCount: plan.slices.length,
    totalTargetAmount: addDecimals(plan.slices.map(({ targetAmount }) => targetAmount)),
    conflictingTargetIds,
    template: {
      id: template.id,
      goalName: template.properties?.hs_goal_name ?? null,
      updatedAt: template.updatedAt ?? template.properties?.hs_lastmodifieddate ?? null,
    },
  };
}

type VerifiedCreateProperty =
  | SemanticTemplateProperty
  | 'hs_goal_name'
  | 'hs_goal_type'
  | 'hs_milestone'
  | 'hs_target_amount'
  | 'hs_start_datetime'
  | 'hs_end_datetime'
  | 'hs_group_correlation_uuid'
  | 'hs_goal_target_group_id'
  | 'hubspot_owner_id'
  | 'hs_assignee_team_id'
  | 'hubspot_team_id'
  | 'hs_pipeline_ids'
  | 'hs_should_notify_on_edit_updates';

export interface GoalFamilyCreateResult {
  verified: boolean;
  verificationPerformed: boolean;
  batchSuccessful: boolean;
  approvalToken: string;
  familyId: string;
  targetGroupId: string;
  createdIds: string[];
  mismatches: Array<{
    id: string;
    property: VerifiedCreateProperty;
    expected: string;
    actual: string | null;
  }>;
  hubspotStatus: string | null;
  hubspotErrors: unknown[];
  mutationPhase:
    | 'create_request_indeterminate'
    | 'create_response_incomplete'
    | 'verification_indeterminate'
    | 'verification_failed'
    | 'verified';
  indeterminate: boolean;
  reconciliationRequired: boolean;
  concurrencyLimitation: string;
  partialCreationRisk: string;
}

function validatePlan(plan: GoalFamilyCreatePlan): void {
  validateIdentifiers({ familyId: plan.familyId, targetGroupId: plan.targetGroupId });
  if (!plan.templateGoalTargetId.trim()) throw new Error('A template goal target ID is required.');
  if (!plan.goalName.trim()) throw new Error('A goal name is required.');
  if (!plan.goalType.trim()) throw new Error('A goal type is required.');
  if (plan.milestone !== 'monthly') throw new Error('Only monthly goal families are supported.');
  if (!plan.assignee.id.trim()) throw new Error('The goal assignee ID is required.');
  for (const property of SEMANTIC_TEMPLATE_PROPERTIES) {
    if (!plan.semanticProperties[property]?.trim()) {
      throw new Error(`The creation plan is missing UI-semantic property ${property}.`);
    }
  }
  validateAndNormalizeSlices(plan.slices);
}

function plansEqual(left: GoalFamilyCreatePlan, right: GoalFamilyCreatePlan): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function creationProperties(
  plan: GoalFamilyCreatePlan,
  slice: NormalizedGoalFamilySlice,
): Record<string, string> {
  return {
    ...plan.semanticProperties,
    hs_goal_name: plan.goalName,
    hs_goal_type: plan.goalType,
    hs_milestone: plan.milestone,
    hs_target_amount: slice.targetAmount,
    hs_start_datetime: slice.start,
    hs_end_datetime: slice.end,
    hs_group_correlation_uuid: plan.familyId,
    hs_goal_target_group_id: plan.targetGroupId,
    ...(plan.assignee.type === 'owner'
      ? { hubspot_owner_id: plan.assignee.id }
      : { [plan.semanticProperties.hs_assignee_property_name]: plan.assignee.id }),
    ...(plan.pipelineIds === null ? {} : { hs_pipeline_ids: plan.pipelineIds }),
    hs_should_notify_on_edit_updates: String(plan.notifyOnEdit),
  };
}

function traceIdFor(plan: GoalFamilyCreatePlan, slice: NormalizedGoalFamilySlice): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ familyId: plan.familyId, targetGroupId: plan.targetGroupId, slice }))
    .digest('hex');
  return `sha256:${digest}`;
}

async function readCreatedTargets(
  ids: string[],
  request: HubSpotGoalFamilyRequestLike,
): Promise<GoalTargetRecord[]> {
  const response = await request<BatchGoalResponse>({
    path: '/crm/v3/objects/goal_targets/batch/read',
    method: 'POST',
    body: {
      properties: [...TEMPLATE_PROPERTIES],
      propertiesWithHistory: [],
      inputs: ids.map((id) => ({ id })),
    },
  });
  if (!response || response.status !== 'COMPLETE') {
    throw new Error(`HubSpot verification read did not complete (status: ${response?.status ?? 'missing'}).`);
  }
  if (!Number.isInteger(response.numErrors) || (response.numErrors as number) < 0) {
    throw new Error('HubSpot verification read returned a malformed numErrors value.');
  }
  if (!Array.isArray(response.errors)) {
    throw new Error('HubSpot verification read returned a malformed errors collection; expected an array.');
  }
  if (response.numErrors! > 0 || response.errors.length > 0) {
    throw new Error(`HubSpot verification read returned errors: ${JSON.stringify(response.errors)}`);
  }
  if (!Array.isArray(response.results)) {
    throw new Error('HubSpot verification read returned a malformed results collection; expected an array.');
  }
  const records: GoalTargetRecord[] = [];
  for (const result of response.results as unknown[]) {
    if (
      result === null ||
      typeof result !== 'object' ||
      typeof (result as { id?: unknown }).id !== 'string' ||
      !(result as { id: string }).id.trim() ||
      (result as { properties?: unknown }).properties === null ||
      typeof (result as { properties?: unknown }).properties !== 'object'
    ) {
      throw new Error('HubSpot verification read returned a malformed goal target record.');
    }
    records.push(result as GoalTargetRecord);
  }
  const found = new Set(records.map(({ id }) => id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`HubSpot did not return created goal target ID(s): ${missing.join(', ')}`);
  }
  return records;
}

function canonicalTimestamp(value: string): string | null {
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? null : instant.toISOString();
}

function valuesEqual(property: VerifiedCreateProperty, expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  if (property === 'hs_target_amount') {
    try {
      return canonicalDecimal(expected) === canonicalDecimal(actual);
    } catch {
      return false;
    }
  }
  if (property === 'hs_start_datetime' || property === 'hs_end_datetime') {
    const expectedInstant = canonicalTimestamp(expected);
    const actualInstant = canonicalTimestamp(actual);
    return expectedInstant !== null && expectedInstant === actualInstant;
  }
  return expected === actual;
}

export async function createGoalFamily(
  plan: GoalFamilyCreatePlan,
  approvalToken: string,
  request: HubSpotGoalFamilyRequestLike = hubspotRequest,
): Promise<GoalFamilyCreateResult> {
  validatePlan(plan);
  const template = await readTemplate(plan.templateGoalTargetId, request);
  const reconstructedPlan = planFromTemplate(
    normalizeDraft({
      templateGoalTargetId: plan.templateGoalTargetId,
      goalName: plan.goalName,
      slices: plan.slices,
      notifyOnEdit: plan.notifyOnEdit,
    }),
    template,
    { familyId: plan.familyId, targetGroupId: plan.targetGroupId },
  );
  if (!plansEqual(plan, reconstructedPlan)) {
    throw new Error('Creation plan no longer matches the source template or supplied payload. Run the preview again.');
  }

  const conflicts = await findConflicts(plan, request);
  const conflictingTargetIds = conflicts.map(({ id }) => id);
  const expectedToken = approvalTokenFor(plan, template, conflictingTargetIds);
  if (approvalToken !== expectedToken || conflictingTargetIds.length > 0) {
    throw new Error(
      'Approval token does not match the current template, conflict state, and exact creation plan. ' +
      'Run hubspot_preview_goal_family_create again and approve the new preview.',
    );
  }

  const concurrencyLimitation =
    'HubSpot does not support conditional goal-target creates. The approval token confirms only the ' +
    'template and overlap state observed by the final pre-write reads. Another goal can be created after ' +
    'those reads or around verification. Verification confirms only the state observed by the follow-up read.';
  const partialCreationRisk =
    'A failed, timed-out, or partial batch-create response can leave some goal targets created. ' +
    'Do not retry blindly; search by the returned familyId and inspect any returned IDs first.';

  const resultBase = {
    approvalToken,
    familyId: plan.familyId,
    targetGroupId: plan.targetGroupId,
    concurrencyLimitation,
    partialCreationRisk,
  };

  let createResponse: BatchGoalResponse | undefined;
  try {
    createResponse = await request<BatchGoalResponse>({
      path: '/crm/v3/objects/goal_targets/batch/create',
      method: 'POST',
      body: {
        inputs: plan.slices.map((slice) => ({
          associations: [],
          objectWriteTraceId: traceIdFor(plan, slice),
          properties: creationProperties(plan, slice),
        })),
      },
    });
  } catch (err) {
    return {
      ...resultBase,
      verified: false,
      verificationPerformed: false,
      batchSuccessful: false,
      createdIds: [],
      mismatches: [],
      hubspotStatus: null,
      hubspotErrors: [{
        phase: 'batch_create_request',
        message: err instanceof Error ? err.message : String(err),
      }],
      mutationPhase: 'create_request_indeterminate',
      indeterminate: true,
      reconciliationRequired: true,
    };
  }

  if (!createResponse || !Array.isArray(createResponse.results)) {
    return {
      ...resultBase,
      verified: false,
      verificationPerformed: false,
      batchSuccessful: false,
      createdIds: [],
      mismatches: [],
      hubspotStatus: createResponse?.status ?? null,
      hubspotErrors: [{
        phase: 'batch_create_response',
        message: 'HubSpot returned a malformed batch-create response without an explicit results array.',
      }],
      mutationPhase: 'create_response_incomplete',
      indeterminate: true,
      reconciliationRequired: true,
    };
  }

  const rawResults: unknown[] = createResponse.results;
  const resultIds: string[] = [];
  let malformedResultCount = 0;
  for (const result of rawResults) {
    if (
      result === null ||
      typeof result !== 'object' ||
      typeof (result as { id?: unknown }).id !== 'string' ||
      !(result as { id: string }).id.trim()
    ) {
      malformedResultCount += 1;
      continue;
    }
    resultIds.push((result as { id: string }).id);
  }
  const uniqueResultIds = new Set(resultIds);
  const rawHubspotErrors: unknown = createResponse.errors;
  const malformedErrorCollection = rawHubspotErrors !== undefined && !Array.isArray(rawHubspotErrors);
  const hubspotErrors: unknown[] = Array.isArray(rawHubspotErrors) ? [...rawHubspotErrors] : [];
  if (malformedErrorCollection) {
    hubspotErrors.push({
      phase: 'batch_create_response',
      message: 'HubSpot returned a malformed errors collection; expected an array.',
    });
  }
  if (malformedResultCount > 0) {
    hubspotErrors.push({
      phase: 'batch_create_response',
      message: `HubSpot returned ${malformedResultCount} malformed result element(s) without a valid ID.`,
    });
  }
  const batchSuccessful = Boolean(
    malformedResultCount === 0 &&
    createResponse.status === 'COMPLETE' &&
    (createResponse.numErrors ?? hubspotErrors.length) === 0 &&
    hubspotErrors.length === 0 &&
    resultIds.length === plan.slices.length &&
    uniqueResultIds.size === plan.slices.length,
  );

  if (!batchSuccessful) {
    return {
      ...resultBase,
      verified: false,
      verificationPerformed: false,
      batchSuccessful: false,
      createdIds: resultIds,
      mismatches: [],
      hubspotStatus: createResponse.status ?? null,
      hubspotErrors,
      mutationPhase: 'create_response_incomplete',
      indeterminate: true,
      reconciliationRequired: true,
    };
  }

  let createdRecords: GoalTargetRecord[];
  try {
    createdRecords = await readCreatedTargets(resultIds, request);
  } catch (err) {
    return {
      ...resultBase,
      verified: false,
      verificationPerformed: false,
      batchSuccessful: true,
      createdIds: resultIds,
      mismatches: [],
      hubspotStatus: createResponse.status ?? null,
      hubspotErrors: [{
        phase: 'verification_read',
        message: err instanceof Error ? err.message : String(err),
      }],
      mutationPhase: 'verification_indeterminate',
      indeterminate: true,
      reconciliationRequired: true,
    };
  }
  const expectedByStart = new Map(plan.slices.map((slice) => [canonicalTimestamp(slice.start)!, slice]));
  const seenStarts = new Set<string>();
  const mismatches: GoalFamilyCreateResult['mismatches'] = [];
  for (const record of createdRecords) {
    const actualProperties = record.properties ?? {};
    const actualStart = actualProperties.hs_start_datetime ?? null;
    const actualStartKey = actualStart === null ? null : canonicalTimestamp(actualStart);
    const slice = actualStartKey === null ? undefined : expectedByStart.get(actualStartKey);
    if (!slice || seenStarts.has(actualStartKey!)) {
      mismatches.push({
        id: record.id,
        property: 'hs_start_datetime',
        expected: [...expectedByStart.keys()].join(' or '),
        actual: actualStart,
      });
      continue;
    }
    seenStarts.add(actualStartKey!);
    const expectedProperties = creationProperties(plan, slice);
    for (const [property, expected] of Object.entries(expectedProperties) as Array<[
      VerifiedCreateProperty,
      string,
    ]>) {
      const actual = actualProperties[property] ?? null;
      if (!valuesEqual(property, expected, actual)) {
        mismatches.push({ id: record.id, property, expected, actual });
      }
    }
  }
  for (const expectedStart of expectedByStart.keys()) {
    if (!seenStarts.has(expectedStart)) {
      mismatches.push({
        id: 'missing',
        property: 'hs_start_datetime',
        expected: expectedStart,
        actual: null,
      });
    }
  }

  return {
    ...resultBase,
    verified: mismatches.length === 0,
    verificationPerformed: true,
    batchSuccessful: true,
    createdIds: resultIds,
    mismatches,
    hubspotStatus: createResponse.status ?? null,
    hubspotErrors,
    mutationPhase: mismatches.length === 0 ? 'verified' : 'verification_failed',
    indeterminate: false,
    reconciliationRequired: mismatches.length > 0,
  };
}

const GoalFamilySliceSchema = z.object({
  start: z.string().min(1).describe('UTC month start, for example 2026-07-01T00:00:00Z.'),
  end: z.string().min(1).describe('UTC month end, for example 2026-07-31T23:59:59.999Z.'),
  targetAmount: z.string().min(1)
    .describe('Exact non-negative decimal target amount as a string.'),
});

const GoalFamilyDraftSchema = z.object({
  templateGoalTargetId: z.string().min(1)
    .describe('Internal ID of an existing working goal target whose type, cadence, assignee, pipeline, and notification defaults will be copied.'),
  goalName: z.string().min(1).describe('Name for the new goal family.'),
  slices: z.array(GoalFamilySliceSchema).length(12)
    .describe('Exactly 12 chronological, contiguous monthly slices for the complete family.'),
  notifyOnEdit: z.boolean().optional()
    .describe('Optional override for edit notifications. Defaults to the template state.'),
});

const GoalFamilyPlanSliceSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
  targetAmount: z.string().min(1)
    .describe('Exact normalized decimal target amount returned by the preview tool.'),
});

const GoalFamilySemanticPropertiesSchema = z.object({
  hs_assignee_property_name: z.string().min(1),
  hs_fiscal_year_offset: z.string().min(1),
  hs_forecast_type_id: z.string().min(1),
  hs_goal_target_currency_code: z.string().min(1),
  hs_is_forecastable: z.string().min(1),
  hs_kpi_filter_groups: z.string().min(1),
  hs_kpi_filter_groups_for_key_grouping: z.string().min(1),
  hs_kpi_filter_groups_for_key_team_grouping: z.string().min(1),
  hs_kpi_is_team_rollup: z.string().min(1),
  hs_kpi_metric_type: z.string().min(1),
  hs_kpi_object_type_id: z.string().min(1),
  hs_kpi_property_name: z.string().min(1),
  hs_kpi_single_object_custom_goal_type_name: z.string().min(1),
  hs_kpi_time_period_property: z.string().min(1),
  hs_kpi_time_period_property_type: z.string().min(1),
  hs_kpi_tracking_method: z.string().min(1),
  hs_kpi_unit_type: z.string().min(1),
  hs_template_id: z.string().min(1),
});

const GoalFamilyPlanSchema = z.object({
  templateGoalTargetId: z.string().min(1),
  goalName: z.string().min(1),
  familyId: z.string().uuid(),
  targetGroupId: z.string().regex(/^\d+$/),
  goalType: z.string().min(1),
  milestone: z.literal('monthly'),
  assignee: z.discriminatedUnion('type', [
    z.object({ type: z.literal('owner'), id: z.string().min(1) }),
    z.object({ type: z.literal('team'), id: z.string().min(1) }),
  ]),
  pipelineIds: z.string().nullable(),
  notifyOnEdit: z.boolean(),
  semanticProperties: GoalFamilySemanticPropertiesSchema,
  slices: z.array(GoalFamilyPlanSliceSchema).length(12),
});

function previewMarkdown(preview: GoalFamilyCreatePreview): string {
  return [
    '## Goal family creation preview',
    '',
    `Approval token: \`${preview.approvalToken}\``,
    `Template target: \`${preview.template.id}\` (${preview.template.goalName ?? 'unnamed'})`,
    `New family ID: \`${preview.plan.familyId}\``,
    `New target-group ID: \`${preview.plan.targetGroupId}\``,
    `Assignee: ${preview.plan.assignee.type} \`${preview.plan.assignee.id}\``,
    `Goal type: \`${preview.plan.goalType}\``,
    `Total target: ${preview.totalTargetAmount}`,
    '',
    '| Period | Target |',
    '| --- | ---: |',
    ...preview.plan.slices.map((slice) => `| ${slice.start} → ${slice.end} | ${slice.targetAmount} |`),
    '',
    '_No changes were made. Pass the exact returned plan and approval token to `hubspot_create_goal_family` only after explicit approval._',
  ].join('\n');
}

export function formatGoalFamilyCreateToolResult(
  result: GoalFamilyCreateResult,
  responseFormat: 'markdown' | 'json',
): CallToolResult {
  const text = result.verified
    ? `Created and verified ${result.createdIds.length} HubSpot goal target(s): ${result.createdIds.join(', ')}`
    : `Goal-family creation is not verified (phase: ${result.mutationPhase}, status: ${result.hubspotStatus}, ` +
      `familyId: ${result.familyId}, targetGroupId: ${result.targetGroupId}, returned IDs: ` +
      `${result.createdIds.join(', ') || 'none'}, errors: ${JSON.stringify(result.hubspotErrors)}, ` +
      `mismatches: ${JSON.stringify(result.mismatches)}). ${result.partialCreationRisk}`;
  const response = toolResult(
    responseFormat === 'json' ? truncate(JSON.stringify(result, null, 2)) : text,
    result,
  );
  if (!result.verified) response.isError = true;
  return response;
}

export function registerGoalFamilyCreateTools(server: McpServer): void {
  server.registerTool(
    'hubspot_preview_goal_family_create',
    {
      title: 'Preview a new monthly goal family',
      description:
        'Read a working UI-enriched HubSpot goal target as a template, copy its explicit assignee, fiscal, ' +
        'forecast, currency, KPI, and template-definition allowlist, validate exactly 12 contiguous monthly ' +
        'targets, reject overlapping goals for the same assignee and goal type, and return an exact no-write ' +
        'creation plan plus an approval token. This tool generates new family identifiers but does not create records.',
      inputSchema: {
        draft: GoalFamilyDraftSchema,
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
        const preview = await previewGoalFamilyCreate(args.draft);
        return args.response_format === 'json'
          ? toolResult(truncate(JSON.stringify(preview, null, 2)), preview)
          : toolResult(truncate(previewMarkdown(preview)), preview);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'hubspot_create_goal_family',
    {
      title: 'Create an approved monthly goal family',
      description:
        'Create one complete monthly HubSpot goal family from the exact plan returned by ' +
        'hubspot_preview_goal_family_create. Re-reads the template and overlapping-goal state before writing, ' +
        'rejects stale or changed plans, validates the complete batch response, and re-reads every created ' +
        'target to verify all written properties. This is non-idempotent: never retry blindly after a timeout ' +
        'or partial response; search by familyId first.',
      inputSchema: {
        plan: GoalFamilyPlanSchema,
        approvalToken: z.string().regex(/^sha256:[a-f0-9]{64}$/)
          .describe('Exact approval token returned with this plan by hubspot_preview_goal_family_create.'),
        response_format: ResponseFormat,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await createGoalFamily(args.plan, args.approvalToken);
        return formatGoalFamilyCreateToolResult(result, args.response_format);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
