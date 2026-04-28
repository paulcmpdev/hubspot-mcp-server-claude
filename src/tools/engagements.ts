/**
 * Engagement tools — tasks, calls, meetings, notes, emails.
 *
 * These are the objects HubSpot's hosted MCP server (mcp.hubspot.com) blocks
 * when "Sensitive Data" is enabled on the account. By talking to the regular
 * /crm/v3/objects API directly via a Private App token, we sidestep that
 * restriction entirely.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerCreateTool,
  registerGetTool,
  registerSearchTool,
  registerUpdateTool,
  type ObjectToolSpec,
} from './_factories.js';

const TASKS: ObjectToolSpec = {
  toolNoun: 'tasks',
  singular: 'task',
  plural: 'tasks',
  apiPath: 'tasks',
  defaultProperties: [
    'hs_task_subject',
    'hs_task_body',
    'hs_task_status',
    'hs_task_priority',
    'hs_task_type',
    'hs_timestamp',
    'hubspot_owner_id',
  ],
  columns: [
    { property: 'hs_task_subject', label: 'subject' },
    { property: 'hs_task_status', label: 'status' },
    { property: 'hs_task_priority', label: 'priority' },
    { property: 'hs_timestamp', label: 'due' },
    { property: 'hubspot_owner_id', label: 'owner' },
  ],
  titleProperty: 'hs_task_subject',
};

const CALLS: ObjectToolSpec = {
  toolNoun: 'calls',
  singular: 'call',
  plural: 'calls',
  apiPath: 'calls',
  defaultProperties: [
    'hs_call_title',
    'hs_call_body',
    'hs_call_direction',
    'hs_call_duration',
    'hs_call_disposition',
    'hs_call_status',
    'hs_timestamp',
    'hubspot_owner_id',
  ],
  columns: [
    { property: 'hs_call_title', label: 'title' },
    { property: 'hs_call_direction', label: 'direction' },
    { property: 'hs_call_disposition', label: 'disposition' },
    { property: 'hs_timestamp', label: 'when' },
    { property: 'hubspot_owner_id', label: 'owner' },
  ],
  titleProperty: 'hs_call_title',
};

const MEETINGS: ObjectToolSpec = {
  toolNoun: 'meetings',
  singular: 'meeting',
  plural: 'meetings',
  apiPath: 'meetings',
  defaultProperties: [
    'hs_meeting_title',
    'hs_meeting_body',
    'hs_meeting_start_time',
    'hs_meeting_end_time',
    'hs_meeting_outcome',
    'hs_meeting_location',
    'hubspot_owner_id',
  ],
  columns: [
    { property: 'hs_meeting_title', label: 'title' },
    { property: 'hs_meeting_start_time', label: 'start' },
    { property: 'hs_meeting_outcome', label: 'outcome' },
    { property: 'hubspot_owner_id', label: 'owner' },
  ],
  titleProperty: 'hs_meeting_title',
};

const NOTES: ObjectToolSpec = {
  toolNoun: 'notes',
  singular: 'note',
  plural: 'notes',
  apiPath: 'notes',
  defaultProperties: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id'],
  columns: [
    { property: 'hs_note_body', label: 'body' },
    { property: 'hs_timestamp', label: 'when' },
    { property: 'hubspot_owner_id', label: 'owner' },
  ],
};

const EMAILS: ObjectToolSpec = {
  toolNoun: 'emails',
  singular: 'email',
  plural: 'emails',
  apiPath: 'emails',
  defaultProperties: [
    'hs_email_subject',
    'hs_email_text',
    'hs_email_direction',
    'hs_email_status',
    'hs_email_to_email',
    'hs_email_from_email',
    'hs_timestamp',
    'hubspot_owner_id',
  ],
  columns: [
    { property: 'hs_email_subject', label: 'subject' },
    { property: 'hs_email_direction', label: 'direction' },
    { property: 'hs_email_status', label: 'status' },
    { property: 'hs_timestamp', label: 'when' },
  ],
  titleProperty: 'hs_email_subject',
};

export function registerEngagementTools(server: McpServer): void {
  // Tasks — full CRUD-minus-D
  registerSearchTool(server, TASKS);
  registerGetTool(server, TASKS);
  registerCreateTool(server, TASKS);
  registerUpdateTool(server, TASKS);

  // Calls — search + create
  registerSearchTool(server, CALLS);
  registerCreateTool(server, CALLS);

  // Meetings — search + create
  registerSearchTool(server, MEETINGS);
  registerCreateTool(server, MEETINGS);

  // Notes — search + create
  registerSearchTool(server, NOTES);
  registerCreateTool(server, NOTES);

  // Emails — search + get (creating logged engagements has nuances; v2)
  registerSearchTool(server, EMAILS);
  registerGetTool(server, EMAILS);
}
