/**
 * Markdown formatters for HubSpot CRM objects.
 *
 * All tools support `response_format: "markdown" | "json"`. JSON mode is for
 * programmatic consumption; markdown is the LLM-friendly default.
 */

import { CHARACTER_LIMIT } from '../constants.js';
import type {
  HubSpotFile,
  HubSpotFileImportTask,
  HubSpotFileSignedUrl,
  HubSpotObject,
  HubSpotOwner,
  HubSpotProperty,
} from '../types.js';

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

/** Render a single file from File Manager. */
export function formatFile(file: HubSpotFile): string {
  const lines = [
    `- **id**: ${file.id}`,
    file.name ? `- **name**: ${file.name}` : null,
    file.extension ? `- **extension**: ${file.extension}` : null,
    file.size !== undefined ? `- **size**: ${file.size.toLocaleString()} bytes` : null,
    file.type ? `- **type**: ${file.type}` : null,
    file.access ? `- **access**: ${file.access}` : null,
    file.path ? `- **path**: ${file.path}` : null,
    file.url ? `- **url**: ${file.url}` : null,
    file.defaultHostingUrl && file.defaultHostingUrl !== file.url
      ? `- **defaultHostingUrl**: ${file.defaultHostingUrl}`
      : null,
    file.parentFolderId ? `- **parentFolderId**: ${file.parentFolderId}` : null,
    file.archived ? `- **archived**: true` : null,
    file.createdAt ? `- **createdAt**: ${file.createdAt}` : null,
    file.updatedAt ? `- **updatedAt**: ${file.updatedAt}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

/** Render a list of files as a markdown table. */
export function formatFileList(files: HubSpotFile[], opts: { title: string; total?: number }): string {
  if (files.length === 0) return `## ${opts.title}\n\n_No results._`;
  const total = opts.total ?? files.length;
  const rows = files.map(
    (f) =>
      `| ${f.id} | ${(f.name ?? '—').replace(/\|/g, '\\|')} | ${f.extension ?? '—'} | ${
        f.size !== undefined ? f.size.toLocaleString() : '—'
      } | ${f.access ?? '—'} |`,
  );
  return [
    `## ${opts.title}`,
    '',
    `_Showing ${files.length} of ${total}._`,
    '',
    '| id | name | ext | size | access |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Render a signed-URL response. */
export function formatSignedUrl(signed: HubSpotFileSignedUrl, fileId: string): string {
  const lines = [
    `## Signed download URL for file \`${fileId}\``,
    '',
    `**URL**: ${signed.url}`,
  ];
  if (signed.expiresAt) lines.push(`**Expires**: ${signed.expiresAt}`);
  if (signed.size) {
    const w = signed.size.width;
    const h = signed.size.height;
    if (w || h) lines.push(`**Image size**: ${w ?? '?'}×${h ?? '?'}`);
  }
  return lines.join('\n');
}

/** Render an async URL-import task response. */
export function formatImportTask(task: HubSpotFileImportTask): string {
  const lines = [
    `## File import task`,
    '',
    `- **task id**: ${task.id}`,
    `- **status**: ${task.status}`,
  ];
  if (task.result) {
    lines.push('', '### Imported file', '', formatFile(task.result));
  }
  if (task.errors && task.errors.length > 0) {
    lines.push('', '### Errors');
    for (const e of task.errors) lines.push(`- ${e.message}`);
  }
  return lines.join('\n');
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
