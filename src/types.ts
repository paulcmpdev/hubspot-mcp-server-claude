/**
 * Shared TypeScript types for HubSpot REST API responses.
 *
 * These mirror the canonical CRM v3 object shape — properties bag, associations
 * bag, system timestamps. We deliberately leave `properties` loose because the
 * available fields vary by object type and account configuration.
 */

/** Output format for tool responses. */
export enum ResponseFormat {
  MARKDOWN = 'markdown',
  JSON = 'json',
}

/** Raw HubSpot CRM object — the shape returned by /crm/v3/objects/{type}/{id} */
export interface HubSpotObject {
  id: string;
  properties: Record<string, string | number | boolean | null>;
  propertiesWithHistory?: Record<string, unknown>;
  associations?: Record<string, AssociationsBag>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

export interface AssociationsBag {
  results: Array<{ id: string; type: string }>;
  paging?: Paging;
}

export interface Paging {
  next?: { after: string; link?: string };
  prev?: { before: string; link?: string };
}

export interface CollectionResponse<T = HubSpotObject> {
  results: T[];
  paging?: Paging;
  total?: number;
}

/** A property definition from /crm/v3/properties/{objectType} */
export interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  description?: string;
  groupName?: string;
  options?: Array<{ label: string; value: string; description?: string; displayOrder?: number; hidden?: boolean }>;
  calculated?: boolean;
  externalOptions?: boolean;
  hasUniqueValue?: boolean;
  hidden?: boolean;
  hubspotDefined?: boolean;
  modificationMetadata?: { archivable: boolean; readOnlyDefinition: boolean; readOnlyValue: boolean };
  formField?: boolean;
}

export interface HubSpotPropertiesResponse {
  results: HubSpotProperty[];
}

/** Owner record from /crm/v3/owners */
export interface HubSpotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  userId?: number;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  teams?: Array<{ id: string; name: string; primary?: boolean }>;
}

/** Search request body for POST /crm/v3/objects/{type}/search */
export interface HubSpotSearchRequest {
  filterGroups?: Array<{ filters: HubSpotSearchFilter[] }>;
  sorts?: Array<{ propertyName: string; direction: 'ASCENDING' | 'DESCENDING' }>;
  query?: string;
  properties?: string[];
  limit?: number;
  after?: string;
}

export interface HubSpotSearchFilter {
  propertyName: string;
  operator:
    | 'EQ'
    | 'NEQ'
    | 'LT'
    | 'LTE'
    | 'GT'
    | 'GTE'
    | 'BETWEEN'
    | 'IN'
    | 'NOT_IN'
    | 'HAS_PROPERTY'
    | 'NOT_HAS_PROPERTY'
    | 'CONTAINS_TOKEN'
    | 'NOT_CONTAINS_TOKEN';
  value?: string | number | boolean;
  values?: Array<string | number>;
  highValue?: string | number;
}

/** Standard CRM object types that HubSpot exposes via /crm/v3/objects/{type}. */
export type ObjectType =
  | 'contacts'
  | 'companies'
  | 'deals'
  | 'tickets'
  | 'tasks'
  | 'calls'
  | 'meetings'
  | 'notes'
  | 'emails'
  | 'line_items'
  | 'products'
  | 'quotes';

/**
 * A file from HubSpot's File Manager (/files/v3/files).
 * Note: this is NOT a CRM v3 object — it has a different shape (no properties bag).
 */
export interface HubSpotFile {
  id: string;
  name?: string;
  type?: string;
  extension?: string;
  encoding?: string;
  size?: number;
  url?: string;
  path?: string;
  parentFolderId?: string | null;
  isUsableInContent?: boolean;
  access?: 'PUBLIC_INDEXABLE' | 'PUBLIC_NOT_INDEXABLE' | 'PRIVATE' | 'HIDDEN_INDEXABLE' | 'HIDDEN_NOT_INDEXABLE' | string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  defaultHostingUrl?: string;
}

/** Response from the async URL-import endpoint. */
export interface HubSpotFileImportTask {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'CANCELED' | 'COMPLETE' | string;
  errors?: Array<{ message: string }>;
  result?: HubSpotFile;
}

/** Response from the signed-url endpoint. */
export interface HubSpotFileSignedUrl {
  url: string;
  expiresAt?: string;
  size?: { width?: number; height?: number };
}

// ---------------------------------------------------------------------------
// Analytics — pipelines, marketing, forms, events, sequences
// ---------------------------------------------------------------------------

/** A pipeline stage from /crm/v3/pipelines/{objectType}/{pipelineId} */
export interface PipelineStage {
  id: string;
  label: string;
  displayOrder: number;
  metadata?: { isClosed?: string | boolean; probability?: string | number };
  archived?: boolean;
}

export interface Pipeline {
  id: string;
  label: string;
  displayOrder: number;
  stages: PipelineStage[];
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Marketing email summary from /marketing/v3/emails */
export interface HubSpotMarketingEmail {
  id: string;
  name?: string;
  subject?: string;
  state?: string; // DRAFT, PUBLISHED, etc.
  type?: string;
  publishDate?: string;
  createdAt?: string;
  updatedAt?: string;
  stats?: HubSpotEmailStatistics;
}

/** Email statistics aggregate. Shape matches /marketing/v3/emails/statistics responses. */
export interface HubSpotEmailStatistics {
  counters?: {
    sent?: number;
    delivered?: number;
    open?: number;
    click?: number;
    bounce?: number;
    unsubscribed?: number;
    spamreport?: number;
    reply?: number;
  };
  ratios?: {
    deliveredratio?: number;
    openratio?: number;
    clickratio?: number;
    bounceratio?: number;
    unsubscribedratio?: number;
  };
  qualifierStats?: Record<string, number>;
}

/** Marketing campaign from /marketing/v3/campaigns */
export interface HubSpotMarketingCampaign {
  id: string;
  properties?: {
    hs_name?: string;
    hs_start_date?: string;
    hs_end_date?: string;
    hs_goal?: string;
    hs_budget_total?: number;
    hs_currency_code?: string;
    hs_owner?: string;
    hs_color_hex?: string;
    [key: string]: unknown;
  };
  createdAt?: string;
  updatedAt?: string;
}

/** Marketing campaign metrics (revenue, contacts, etc.). */
export interface HubSpotCampaignMetrics {
  campaignId: string;
  metrics?: {
    influenced?: { revenue?: number; contacts?: number };
    sessions?: { total?: number };
    contacts?: { firstTouch?: number; lastTouch?: number; influenced?: number };
    revenue?: { firstTouch?: number; lastTouch?: number; influenced?: number };
    [key: string]: unknown;
  };
}

/** A marketing form from /marketing/v3/forms */
export interface HubSpotForm {
  id: string;
  name?: string;
  formType?: string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  fieldGroups?: unknown;
  configuration?: unknown;
  displayOptions?: unknown;
}

/** A form submission. */
export interface HubSpotFormSubmission {
  conversionId?: string;
  submittedAt?: number; // ms epoch
  values?: Array<{ name: string; value: string; objectTypeId?: string }>;
  pageUrl?: string;
  pageTitle?: string;
}

/** Custom event definition from /events/v3/event-definitions */
export interface HubSpotEventDefinition {
  name: string;
  fullyQualifiedName?: string;
  label?: string;
  description?: string;
  primaryObject?: string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  properties?: Array<{ name: string; label: string; type: string }>;
}

/** A custom event occurrence. */
export interface HubSpotEvent {
  occurredAt?: string;
  eventType?: string;
  objectId?: string | number;
  objectType?: string;
  properties?: Record<string, unknown>;
}

/** Sequence summary (where exposed). */
export interface HubSpotSequence {
  id: string;
  name?: string;
  enrolledContactsCount?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Web analytics report bucket. */
export interface AnalyticsBucket {
  breakdown?: string;
  visits?: number;
  visitors?: number;
  pageviews?: number;
  bounces?: number;
  contactsConverted?: number;
  rawViews?: number;
  [key: string]: unknown;
}
