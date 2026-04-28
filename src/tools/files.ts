/**
 * File Manager tools — search, get, signed-url (download), upload-from-url.
 *
 * Files live at /files/v3 — a different API surface from /crm/v3/objects, with
 * a flat shape (no `properties` bag), so the CRM factories don't apply here.
 *
 * Why import-from-url for "create"? HubSpot's synchronous upload endpoint
 * (POST /files/v3/files) takes multipart/form-data with the binary file
 * payload; the JSON-only client this MCP uses can't speak multipart. The
 * import-from-url endpoint is JSON-only, accepts any reachable URL, and
 * returns an async task you can poll. Practical for LLM-driven workflows:
 * the model fetches/generates a URL, hands it to HubSpot, HubSpot copies it.
 *
 * Required HubSpot scope: `files` (read + write).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hubspotRequest } from '../services/hubspot-client.js';
import {
  formatFile,
  formatFileList,
  formatImportTask,
  formatSignedUrl,
  truncate,
} from '../services/formatters.js';
import { toolError, toolResult } from './_helpers.js';
import { After, Limit, ResponseFormat } from '../schemas/common.js';
import type {
  CollectionResponse,
  HubSpotFile,
  HubSpotFileImportTask,
  HubSpotFileSignedUrl,
} from '../types.js';

const FileAccess = z
  .enum([
    'PUBLIC_INDEXABLE',
    'PUBLIC_NOT_INDEXABLE',
    'PRIVATE',
    'HIDDEN_INDEXABLE',
    'HIDDEN_NOT_INDEXABLE',
  ])
  .describe(
    'File access level. PUBLIC_* are externally reachable; PRIVATE requires a signed URL; HIDDEN_* hide from the file manager UI.',
  );

const DuplicateValidationStrategy = z
  .enum(['NONE', 'REJECT', 'RETURN_EXISTING'])
  .describe(
    'How to handle existing files with the same name in the same folder. ' +
      'NONE skips dedup; REJECT errors; RETURN_EXISTING reuses the existing file id.',
  );

const DuplicateValidationScope = z
  .enum(['ENTIRE_PORTAL', 'EXACT_FOLDER'])
  .describe('Where to look for duplicates. EXACT_FOLDER is the safer default.');

export function registerFileTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // hubspot_search_files — GET /files/v3/files
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_search_files',
    {
      title: 'Search files',
      description:
        'List or search files in HubSpot\'s File Manager. ' +
        'Filter by `name` (substring match), `parentFolderId`, `extension`, `type`, ' +
        'or `archived`. Results are paginated via `after`. Requires the `files` scope.',
      inputSchema: {
        name: z.string().optional().describe('Filter by filename (substring).'),
        parentFolderId: z
          .string()
          .optional()
          .describe('Restrict to a single folder by ID.'),
        parentFolderPath: z
          .string()
          .optional()
          .describe('Restrict to a single folder by path (alternative to parentFolderId).'),
        type: z
          .string()
          .optional()
          .describe('MIME type filter (e.g. `IMG`, `DOCUMENT`, `VIDEO`).'),
        extension: z
          .string()
          .optional()
          .describe('File extension filter (e.g. `pdf`, `png`).'),
        archived: z.boolean().optional().describe('Include archived files (default: false).'),
        sort: z
          .string()
          .optional()
          .describe('Sort by a field, prefix `-` for descending. e.g. `-createdAt`.'),
        limit: Limit,
        after: After,
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const response = await hubspotRequest<CollectionResponse<HubSpotFile>>({
          path: '/files/v3/files',
          query: {
            name: args.name,
            parentFolderId: args.parentFolderId,
            parentFolderPath: args.parentFolderPath,
            type: args.type,
            extension: args.extension,
            archived: args.archived,
            sort: args.sort,
            limit: args.limit,
            after: args.after,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(response, null, 2)), response);
        }

        const md = formatFileList(response.results, {
          title: 'Files',
          total: response.total,
        });
        const cursor = response.paging?.next?.after;
        const footer = cursor ? `\n\n_Next cursor: \`${cursor}\`_` : '';
        return toolResult(truncate(md + footer), response);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_file — GET /files/v3/files/{fileId}
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_file',
    {
      title: 'Get file metadata',
      description:
        'Fetch metadata for a single file by ID — name, size, MIME type, access level, ' +
        'parent folder, public URL (if accessible), and timestamps. ' +
        'Use `hubspot_get_file_signed_url` to get a downloadable link for PRIVATE files.',
      inputSchema: {
        fileId: z.string().min(1).describe('The HubSpot file ID.'),
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const file = await hubspotRequest<HubSpotFile>({
          path: `/files/v3/files/${encodeURIComponent(args.fileId)}`,
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(file, null, 2)), file);
        }
        const title = file.name ?? `File ${file.id}`;
        return toolResult(truncate(`## ${title}\n\n${formatFile(file)}`), file);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_get_file_signed_url — GET /files/v3/files/{fileId}/signed-url
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_get_file_signed_url',
    {
      title: 'Get signed download URL for a file',
      description:
        'Mint a short-lived signed URL for downloading a file. ' +
        'Required for PRIVATE files; convenient for PUBLIC ones too. ' +
        'Default expiry is 60 seconds; pass `expirationSeconds` (max 604800 = 7 days) to extend.',
      inputSchema: {
        fileId: z.string().min(1).describe('The HubSpot file ID.'),
        expirationSeconds: z
          .number()
          .int()
          .min(1)
          .max(604_800)
          .optional()
          .describe('Seconds until the URL expires (1 to 604800). Default 60.'),
        upscale: z
          .boolean()
          .optional()
          .describe('For images: allow upscaling when resizing.'),
        size: z
          .enum(['thumb', 'small', 'medium', 'large', 'preview'])
          .optional()
          .describe('Image variant to return (only valid for image files).'),
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        const signed = await hubspotRequest<HubSpotFileSignedUrl>({
          path: `/files/v3/files/${encodeURIComponent(args.fileId)}/signed-url`,
          query: {
            expirationSeconds: args.expirationSeconds,
            upscale: args.upscale,
            size: args.size,
          },
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(signed, null, 2)), signed);
        }
        return toolResult(truncate(formatSignedUrl(signed, args.fileId)), signed);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -------------------------------------------------------------------------
  // hubspot_upload_file_from_url — POST /files/v3/files/import-from-url/async
  // -------------------------------------------------------------------------
  server.registerTool(
    'hubspot_upload_file_from_url',
    {
      title: 'Upload a file by URL (async import)',
      description:
        'Add a file to HubSpot\'s File Manager by providing a publicly reachable URL. ' +
        'HubSpot fetches the URL server-side and stores the result. ' +
        'Returns a task ID; the file becomes available once `status` is `COMPLETE`. ' +
        'For multipart binary uploads, use HubSpot\'s POST /files/v3/files endpoint directly ' +
        '(this server does not support multipart). Requires the `files` scope (write).',
      inputSchema: {
        url: z.string().url().describe('Public URL HubSpot will fetch the file from.'),
        access: FileAccess,
        name: z
          .string()
          .optional()
          .describe('Override the filename in HubSpot. Defaults to the URL\'s last path segment.'),
        folderId: z
          .string()
          .optional()
          .describe('Target folder ID (mutually exclusive with folderPath).'),
        folderPath: z
          .string()
          .optional()
          .describe('Target folder path, e.g. `/uploads/2026`. Created if it doesn\'t exist.'),
        duplicateValidationStrategy: DuplicateValidationStrategy.optional(),
        duplicateValidationScope: DuplicateValidationScope.optional(),
        overwrite: z
          .boolean()
          .optional()
          .describe('If a file with the same name exists, overwrite it (default: false).'),
        ttl: z
          .string()
          .optional()
          .describe('ISO 8601 duration after which HubSpot will auto-delete the file (e.g. `P3M`).'),
        response_format: ResponseFormat,
      },
    },
    async (args) => {
      try {
        if (!args.folderId && !args.folderPath) {
          return toolError('Either `folderId` or `folderPath` is required.');
        }
        if (args.folderId && args.folderPath) {
          return toolError('Provide only one of `folderId` or `folderPath`, not both.');
        }

        const body: Record<string, unknown> = {
          access: args.access,
          url: args.url,
        };
        if (args.name) body.name = args.name;
        if (args.folderId) body.folderId = args.folderId;
        if (args.folderPath) body.folderPath = args.folderPath;
        if (args.duplicateValidationStrategy) body.duplicateValidationStrategy = args.duplicateValidationStrategy;
        if (args.duplicateValidationScope) body.duplicateValidationScope = args.duplicateValidationScope;
        if (args.overwrite !== undefined) body.overwrite = args.overwrite;
        if (args.ttl) body.ttl = args.ttl;

        const task = await hubspotRequest<HubSpotFileImportTask>({
          path: '/files/v3/files/import-from-url/async',
          method: 'POST',
          body,
        });

        if (args.response_format === 'json') {
          return toolResult(truncate(JSON.stringify(task, null, 2)), task);
        }
        return toolResult(truncate(formatImportTask(task)), task);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
