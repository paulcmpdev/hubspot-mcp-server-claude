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
