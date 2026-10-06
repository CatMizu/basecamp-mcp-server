import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config } from '../../../config.js';
import { ResponseFormat } from '../../../constants.js';
import type { BasecampUpload } from '../../../lib/types.js';
import { bcFetch } from './basecamp-api.js';
import { getBasecampCtx } from './auth-context.js';
import type { BasecampContext } from './auth-context.js';
import { buildResult, toolError } from './utils.js';
import {
  isValidSgid,
  MAX_UPLOAD_BYTES,
  uploadStore,
  UploadStore,
  UploadTicket,
} from '../uploads/store.js';

const responseFormatSchema = {
  response_format: z
    .nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe('"markdown" for human-readable, "json" for programmatic.'),
};

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function inferContentType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Resolve upload_ids to tickets for the calling user. Throws a model-readable
 * Error if any id is unknown, foreign, unused-yet-unuploaded, used, or expired.
 */
export function resolveAttachments(
  ids: string[],
  ctx: BasecampContext,
  store: UploadStore = uploadStore,
): UploadTicket[] {
  return store.resolveForOwner(ids, ctx);
}

/** One <bc-attachment> per ticket. sgids are re-validated before interpolation. */
export function attachmentHtml(tickets: UploadTicket[]): string {
  return tickets
    .map((t) => {
      if (!isValidSgid(t.sgid)) throw new Error(`upload_id "${t.id}" has an invalid sgid.`);
      return `<bc-attachment sgid="${t.sgid}"></bc-attachment>`;
    })
    .join('');
}

// ─── Exported handlers (testable without McpServer) ────────────────────────

export async function handleCreateUploadUrl(
  params: { filename: string; content_type?: string; response_format: ResponseFormat },
  ctx: BasecampContext,
  store: UploadStore = uploadStore,
  baseUri: string = config.baseUri,
): Promise<CallToolResult> {
  try {
    const contentType = params.content_type ?? inferContentType(params.filename);
    const ticket = store.create(
      { identityId: ctx.identityId, accountId: ctx.accountId, flowId: ctx.flowId },
      params.filename,
      contentType,
    );
    const uploadUrl = `${baseUri.replace(/\/$/, '')}/uploads/${ticket.secret}`;
    const curlCommand = `curl -sS --fail-with-body -X PUT -H "Content-Type: ${contentType}" --data-binary @"<LOCAL_FILE_PATH>" "${uploadUrl}"`;
    const struct = {
      upload_id: ticket.id,
      upload_url: uploadUrl,
      expires_at: new Date(ticket.expiresAt).toISOString(),
      max_bytes: MAX_UPLOAD_BYTES,
      curl_command: curlCommand,
    };
    const markdown = [
      `Upload URL ready for **${params.filename}** (upload_id: ${ticket.id}, expires ${struct.expires_at}).`,
      '',
      'Replace <LOCAL_FILE_PATH> with the absolute path (no ~, it is not expanded inside quotes) and run in your shell:',
      '',
      curlCommand,
      '',
      `Then pass "${ticket.id}" in \`attachments\` of basecamp_post_campfire_message / basecamp_post_message, or as upload_id of basecamp_create_vault_upload.`,
    ].join('\n');
    return buildResult(markdown, struct, params.response_format);
  } catch (err) {
    return toolError(err);
  }
}

export async function handleCreateVaultUpload(
  params: {
    project_id: number;
    vault_id: number;
    upload_id: string;
    description?: string;
    base_name?: string;
    response_format: ResponseFormat;
  },
  ctx: BasecampContext,
  store: UploadStore = uploadStore,
): Promise<CallToolResult> {
  try {
    const [ticket] = resolveAttachments([params.upload_id], ctx, store);
    if (!isValidSgid(ticket.sgid)) {
      throw new Error(`upload_id "${ticket.id}" has an invalid sgid.`);
    }
    const body: Record<string, unknown> = { attachable_sgid: ticket.sgid };
    if (params.description) body.description = params.description;
    if (params.base_name) body.base_name = params.base_name;
    const u = await bcFetch<BasecampUpload>(
      ctx,
      `/buckets/${params.project_id}/vaults/${params.vault_id}/uploads.json`,
      { method: 'POST', body },
    );
    store.markUsed([ticket.id]);
    const struct = { id: u.id, title: u.title, filename: u.filename, app_url: u.app_url };
    return buildResult(
      `Uploaded **${u.filename}** to vault #${params.vault_id} (upload #${u.id}).\n${u.app_url}`,
      struct,
      params.response_format,
    );
  } catch (err) {
    return toolError(err);
  }
}

// ─── Tool registration ──────────────────────────────────────────────────────

export function registerUploadTools(server: McpServer): void {
  // ─── basecamp_create_upload_url ─────────────────────────────────────
  server.registerTool(
    'basecamp_create_upload_url',
    {
      title: 'Get a one-time URL to upload a local file',
      description: `Start sending a local file (image, PDF, anything) to Basecamp. This server cannot read your disk, so it returns a one-time upload URL and a ready curl command.

Steps:
  1. Call this tool with the file's name.
  2. In your shell, replace <LOCAL_FILE_PATH> in curl_command with the file's absolute path (e.g. /Users/me/Desktop/chart.png; no ~, it is not expanded inside the quotes) and run it. The response JSON confirms status "uploaded".
  3. Pass upload_id in the \`attachments\` param of basecamp_post_campfire_message or basecamp_post_message, or as upload_id of basecamp_create_vault_upload (Docs & Files).

Args:
  - filename (string, required) — base name shown in Basecamp, e.g. "chart.png" (no directories).
  - content_type (string, optional) — MIME type; inferred from the extension when omitted.
  - response_format ('markdown'|'json').

Returns:
  { upload_id, upload_url, expires_at, max_bytes, curl_command }.
  The URL expires after 10 minutes and works once. Max size 25 MB. An uploaded file must be attached within 60 minutes.

Error handling:
  - If curl fails or the URL expired, call this tool again for a new URL.`,
      inputSchema: z
        .object({
          filename: z
            .string()
            .min(1)
            .max(255)
            .regex(/^[^/\\\p{Cc}]+$/u, 'Use a base file name without directories or control characters')
            .describe('File name as it should appear in Basecamp, e.g. "chart.png".'),
          content_type: z
            .string()
            .regex(/^[\w.+-]+\/[\w.+-]+$/, 'Use a MIME type like "image/png"')
            .optional()
            .describe('MIME type. Inferred from the extension when omitted.'),
          ...responseFormatSchema,
        })
        .strict().shape,
      outputSchema: {
        upload_id: z.string(),
        upload_url: z.string(),
        expires_at: z.string(),
        max_bytes: z.number(),
        curl_command: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra) => {
      try {
        const ctx = getBasecampCtx(extra.authInfo?.extra);
        return handleCreateUploadUrl(params, ctx);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ─── basecamp_create_vault_upload ───────────────────────────────────
  server.registerTool(
    'basecamp_create_vault_upload',
    {
      title: 'Add an uploaded file to a Docs & Files vault',
      description: `Add a file uploaded via basecamp_create_upload_url to a project's Docs & Files vault (folder).

Args:
  - project_id (number, required).
  - vault_id (number, required) — from basecamp_get_project (vault dock) or basecamp_list_subvaults.
  - upload_id (string, required) — from basecamp_create_upload_url, after the curl upload succeeded.
  - description (string, optional) — HTML description.
  - base_name (string, optional) — new file name without extension.
  - response_format ('markdown'|'json').

Returns:
  { id, title, filename, app_url }. The upload_id is consumed (one-time).`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive(),
          vault_id: z.number().int().positive(),
          upload_id: z.string().min(1),
          description: z.string().optional(),
          base_name: z.string().min(1).max(255).optional(),
          ...responseFormatSchema,
        })
        .strict().shape,
      outputSchema: {
        id: z.number(),
        title: z.string(),
        filename: z.string(),
        app_url: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      try {
        const ctx = getBasecampCtx(extra.authInfo?.extra);
        return handleCreateVaultUpload(params, ctx);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
