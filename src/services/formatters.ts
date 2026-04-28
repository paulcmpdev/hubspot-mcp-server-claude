/**
 * Markdown formatters for HubSpot CRM objects.
 *
 * All tools support `response_format: "markdown" | "json"`. JSON mode is for
 * programmatic consumption; markdown is the LLM-friendly default.
 */

import { CHARACTER_LIMIT } from '../constants.js';
import type { HubSpotObject, HubSpotOwner, HubSpotProperty } from '../types.js';

/** Truncate a string to CHARACTER_LIMIT, appending an indicator. */
export function truncate(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n_(truncated — response exceeded ${limit.toLocaleString()} characters)_`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '_(empty)_';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const str = String(value);
  // HubSpot returns ISO timestamps as strings — leave them alone; the LLM can interpret.
  return str.length > 200 ? `${str.slice(0, 197)}...` : str;
}

/** Render a single CRM object as markdown. */
export function formatObject(obj: HubSpotObject, opts: { title?: string } = {}): string {
  const title = opts.title ?? `Object \`${obj.id}\``;
  const lines: string[] = [`## ${title}`, '', `- **id**: ${obj.id}`];
  if (obj.createdAt) lines.push(`- **createdAt**: ${obj.createdAt}`);
  if (obj.updatedAt) lines.push(`- **updatedAt**: ${obj.updatedAt}`);
  if (obj.archived) lines.push(`- **archived**: true`);

  const props = Object.entries(obj.properties ?? {}).filter(([, v]) => v !== null && v !== '');
  if (props.length > 0) {
    lines.push('', '### Properties', '');
    for (const [key, value] of props) {
      lines.push(`- **${key}**: ${formatValue(value)}`);
    }
  }

  if (obj.associations) {
    const assocLines: string[] = [];
    for (const [type, bag] of Object.entries(obj.associations)) {
      const ids = bag.results.map((r) => r.id).join(', ');
      if (ids) assocLines.push(`- **${type}**: ${ids}`);
    }
    if (assocLines.length > 0) {
      lines.push('', '### Associations', '', ...assocLines);
    }
  }

  return lines.join('\n');
}

/** Render a list of CRM objects as a compact table. */
export function formatObjectList(
  objects: HubSpotObject[],
  opts: { title: string; columns: Array<{ property: string; label?: string }>; total?: number },
): string {
  if (objects.length === 0) return `## ${opts.title}\n\n_No results._`;

  const headers = ['id', ...opts.columns.map((c) => c.label ?? c.property)];
  const sep = headers.map(() => '---');
  const rows = objects.map((obj) => {
    const cells = [obj.id, ...opts.columns.map((c) => formatCell(obj.properties?.[c.property]))];
    return `| ${cells.join(' | ')} |`;
  });

  const total = opts.total ?? objects.length;
  return [
    `## ${opts.title}`,
    '',
    `_Showing ${objects.length} of ${total}._`,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows,
  ].join('\n');
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const str = String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return str.length > 80 ? `${str.slice(0, 77)}...` : str;
}

/** Render an owner record. */
export function formatOwner(owner: HubSpotOwner): string {
  const parts = [
    `- **id**: ${owner.id}`,
    owner.email ? `- **email**: ${owner.email}` : null,
    owner.firstName || owner.lastName
      ? `- **name**: ${[owner.firstName, owner.lastName].filter(Boolean).join(' ')}`
      : null,
    owner.userId !== undefined ? `- **userId**: ${owner.userId}` : null,
    owner.archived ? `- **archived**: true` : null,
  ].filter(Boolean);
  return parts.join('\n');
}

/** Render a property definition for `describe_object`. */
export function formatProperty(prop: HubSpotProperty): string {
  const lines = [
    `### \`${prop.name}\``,
    '',
    `- **label**: ${prop.label}`,
    `- **type**: ${prop.type} (${prop.fieldType})`,
  ];
  if (prop.description) lines.push(`- **description**: ${prop.description}`);
  if (prop.groupName) lines.push(`- **group**: ${prop.groupName}`);
  if (prop.calculated) lines.push(`- **calculated**: true`);
  if (prop.hubspotDefined) lines.push(`- **hubspot-defined**: true`);
  if (prop.hidden) lines.push(`- **hidden**: true`);
  if (prop.modificationMetadata?.readOnlyValue) lines.push(`- **read-only**: true`);
  if (prop.options && prop.options.length > 0) {
    const opts = prop.options
      .filter((o) => !o.hidden)
      .slice(0, 25)
      .map((o) => `\`${o.value}\` (${o.label})`)
      .join(', ');
    lines.push(`- **options**: ${opts}${prop.options.length > 25 ? ' …' : ''}`);
  }
  return lines.join('\n');
}
