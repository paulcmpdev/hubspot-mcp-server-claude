/**
 * Shared helpers for tool handler return values.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Build a uniform CallToolResult with both text and (optionally) structured content.
 *
 * Per the MCP spec, `structuredContent` must be a JSON object — primitives and
 * arrays are wrapped in `{ value: ... }` so callers don't have to remember.
 */
export function toolResult(text: string, structured?: unknown): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text }],
  };

  if (structured !== undefined && structured !== null) {
    const isPlainObject =
      typeof structured === 'object' && !Array.isArray(structured);
    result.structuredContent = isPlainObject
      ? (structured as Record<string, unknown>)
      : { value: structured };
  }

  return result;
}

/** Standard error wrapper — turns thrown errors into MCP isError responses. */
export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
