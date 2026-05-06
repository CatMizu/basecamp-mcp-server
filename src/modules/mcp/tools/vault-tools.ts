import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ResponseFormat, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../../constants.js';
import type {
  BasecampVault,
  BasecampDocument,
  BasecampUpload,
  BasecampSearchResult,
} from '../../../lib/types.js';
import { bcFetch, bcFetchOffsetLimit } from './basecamp-api.js';
import { getBasecampCtx } from './auth-context.js';
import type { BasecampContext } from './auth-context.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildResult, paginate, plainText, toolError } from './utils.js';

const paginationSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .describe('Max items to return (1-100).'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Number of items to skip.'),
};

const responseFormatSchema = {
  response_format: z
    .nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe('"markdown" for human-readable, "json" for programmatic.'),
};

// ─── Exported handlers (testable without McpServer) ────────────────────────

export async function handleGetVault(
  params: { project_id: number; vault_id: number; response_format: ResponseFormat },
  ctx: BasecampContext,
): Promise<CallToolResult> {
  try {
    const v = await bcFetch<BasecampVault>(
      ctx,
      `/buckets/${params.project_id}/vaults/${params.vault_id}.json`,
    );
    const struct = {
      id: v.id,
      title: v.title,
      status: v.status,
      documents_count: v.documents_count,
      uploads_count: v.uploads_count,
      created_at: v.created_at,
      updated_at: v.updated_at,
      app_url: v.app_url,
    };
    const markdown = [
      `# ${v.title}`,
      `Status: ${v.status}`,
      `Documents: ${v.documents_count}   Uploads: ${v.uploads_count}`,
      `Created: ${v.created_at.substring(0, 10)}   Updated: ${v.updated_at.substring(0, 10)}`,
      `Web: ${v.app_url}`,
    ].join('\n');
    return buildResult(markdown, struct, params.response_format);
  } catch (err) {
    return toolError(err);
  }
}

export async function handleListSubvaults(
  params: {
    project_id: number;
    vault_id: number;
    limit: number;
    offset: number;
    response_format: ResponseFormat;
  },
  ctx: BasecampContext,
): Promise<CallToolResult> {
  try {
    const page = await bcFetchOffsetLimit<BasecampVault>(
      ctx,
      `/buckets/${params.project_id}/vaults/${params.vault_id}/vaults.json`,
      params.limit,
      params.offset,
    );
    const items = page.items.map((v) => ({
      id: v.id,
      title: v.title,
      status: v.status,
      documents_count: v.documents_count,
      uploads_count: v.uploads_count,
      app_url: v.app_url,
    }));
    const envelope = paginate(items, params.offset, params.limit, page.total, page.hasMore);
    const markdown = items.length
      ? `Found ${items.length} subfolder${items.length === 1 ? '' : 's'}${page.hasMore ? ' (more available)' : ''}:\n\n` +
        items.map((v) => `- **${v.title}** (id: ${v.id}) — docs: ${v.documents_count}, uploads: ${v.uploads_count}\n  ${v.app_url}`).join('\n')
      : 'No subfolders found.';
    return buildResult(markdown, envelope, params.response_format);
  } catch (err) {
    return toolError(err);
  }
}

export async function handleListDocuments(
  params: {
    project_id: number;
    vault_id: number;
    limit: number;
    offset: number;
    response_format: ResponseFormat;
  },
  ctx: BasecampContext,
): Promise<CallToolResult> {
  try {
    const page = await bcFetchOffsetLimit<BasecampDocument>(
      ctx,
      `/buckets/${params.project_id}/vaults/${params.vault_id}/documents.json`,
      params.limit,
      params.offset,
    );
    const items = page.items.map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status,
      creator: { id: d.creator.id, name: d.creator.name },
      created_at: d.created_at,
      updated_at: d.updated_at,
      app_url: d.app_url,
    }));
    const envelope = paginate(items, params.offset, params.limit, page.total, page.hasMore);
    const markdown = items.length
      ? `Found ${items.length} document${items.length === 1 ? '' : 's'}${page.hasMore ? ' (more available)' : ''}:\n\n` +
        items
          .map(
            (d) =>
              `- **${d.title}** (id: ${d.id}) — by ${d.creator.name}, updated ${d.updated_at.substring(0, 10)}\n  ${d.app_url}`,
          )
          .join('\n')
      : 'No documents found.';
    return buildResult(markdown, envelope, params.response_format);
  } catch (err) {
    return toolError(err);
  }
}

export async function handleGetDocument(
  params: { project_id: number; document_id: number; response_format: ResponseFormat },
  ctx: BasecampContext,
): Promise<CallToolResult> {
  try {
    const d = await bcFetch<BasecampDocument>(
      ctx,
      `/buckets/${params.project_id}/documents/${params.document_id}.json`,
    );
    const struct = {
      id: d.id,
      title: d.title,
      status: d.status,
      content: d.content,
      creator: { id: d.creator.id, name: d.creator.name },
      created_at: d.created_at,
      updated_at: d.updated_at,
      app_url: d.app_url,
    };
    const markdown = [
      `# ${d.title}`,
      `By ${d.creator.name}   ·   Updated ${d.updated_at.substring(0, 10)}`,
      '',
      plainText(d.content),
      '',
      `Web: ${d.app_url}`,
    ]
      .filter(Boolean)
      .join('\n');
    return buildResult(markdown, struct, params.response_format);
  } catch (err) {
    return toolError(err);
  }
}

export async function handleListUploads(
  params: {
    project_id: number;
    vault_id: number;
    limit: number;
    offset: number;
    response_format: ResponseFormat;
  },
  ctx: BasecampContext,
): Promise<CallToolResult> {
  try {
    const page = await bcFetchOffsetLimit<BasecampUpload>(
      ctx,
      `/buckets/${params.project_id}/vaults/${params.vault_id}/uploads.json`,
      params.limit,
      params.offset,
    );
    const items = page.items.map((u) => ({
      id: u.id,
      filename: u.filename,
      content_type: u.content_type,
      byte_size: u.byte_size,
      download_url: u.download_url,
      app_url: u.app_url,
      creator: { id: u.creator.id, name: u.creator.name },
      created_at: u.created_at,
    }));
    const envelope = paginate(items, params.offset, params.limit, page.total, page.hasMore);
    const markdown = items.length
      ? `Found ${items.length} upload${items.length === 1 ? '' : 's'}${page.hasMore ? ' (more available)' : ''}:\n\n` +
        items
          .map(
            (u) =>
              `- **${u.filename}** (id: ${u.id}) — ${u.content_type}, ${u.byte_size} bytes, by ${u.creator.name}\n  ${u.app_url}`,
          )
          .join('\n')
      : 'No uploads found.';
    return buildResult(markdown, envelope, params.response_format);
  } catch (err) {
    return toolError(err);
  }
}

export async function handleGetUpload(
  params: { project_id: number; upload_id: number; response_format: ResponseFormat },
  ctx: BasecampContext,
): Promise<CallToolResult> {
  try {
    const u = await bcFetch<BasecampUpload>(
      ctx,
      `/buckets/${params.project_id}/uploads/${params.upload_id}.json`,
    );
    const struct = {
      id: u.id,
      title: u.title,
      filename: u.filename,
      content_type: u.content_type,
      byte_size: u.byte_size,
      download_url: u.download_url,
      status: u.status,
      creator: { id: u.creator.id, name: u.creator.name },
      created_at: u.created_at,
      updated_at: u.updated_at,
      app_url: u.app_url,
    };
    const markdown = [
      `# ${u.filename}`,
      `Type: ${u.content_type}   ·   Size: ${u.byte_size} bytes`,
      `Uploaded by ${u.creator.name} on ${u.created_at.substring(0, 10)}`,
      `Download: ${u.download_url}`,
      `Web: ${u.app_url}`,
    ].join('\n');
    return buildResult(markdown, struct, params.response_format);
  } catch (err) {
    return toolError(err);
  }
}

export async function handleSearch(
  params: {
    query: string;
    project_id?: number;
    limit: number;
    page: number;
    response_format: ResponseFormat;
  },
  ctx: BasecampContext,
): Promise<CallToolResult> {
  try {
    const queryParams: Record<string, string | number | undefined> = {
      q: params.query,
      bucket: params.project_id,
      per_page: params.limit,
      page: params.page,
    };
    const results = await bcFetch<BasecampSearchResult[]>(ctx, '/search.json', {
      params: queryParams,
    });
    const items = results.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      content_excerpt: r.content_excerpt,
      app_url: r.app_url,
      url: r.url,
      created_at: r.created_at,
      creator: r.creator ? { id: r.creator.id, name: r.creator.name } : null,
      parent: r.parent ? { id: r.parent.id, title: r.parent.title, type: r.parent.type } : null,
      bucket: { id: r.bucket.id, name: r.bucket.name, type: r.bucket.type },
    }));
    const struct = { count: items.length, page: params.page, items };
    const markdown = items.length
      ? `Found ${items.length} result${items.length === 1 ? '' : 's'} (page ${params.page}):\n\n` +
        items
          .map(
            (r) =>
              `- **${r.title}** [${r.type}] — ${r.bucket.name}\n  ${r.app_url}` +
              (r.content_excerpt ? `\n  > ${r.content_excerpt}` : ''),
          )
          .join('\n')
      : `No results for "${params.query}".`;
    return buildResult(markdown, struct, params.response_format);
  } catch (err) {
    return toolError(err);
  }
}

// ─── Tool registration ──────────────────────────────────────────────────────

export function registerVaultTools(server: McpServer): void {
  // ─── basecamp_get_vault ─────────────────────────────────────────────
  server.registerTool(
    'basecamp_get_vault',
    {
      title: 'Get a Basecamp vault (folder)',
      description: `Fetch metadata for a single vault (folder) in a project.

Args:
  - project_id (number, required).
  - vault_id (number, required).
  - response_format ('markdown'|'json', default 'markdown').

Returns:
  { id, title, status, documents_count, uploads_count, created_at, updated_at, app_url }.

Examples:
  - Use when: you have a vault_id and want its document/upload counts.
  - Use basecamp_list_subvaults to discover nested vaults.`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive().describe('Project ID.'),
          vault_id: z.number().int().positive().describe('Vault ID.'),
          ...responseFormatSchema,
        })
        .strict().shape,
      outputSchema: {
        id: z.number(),
        title: z.string(),
        status: z.string(),
        documents_count: z.number(),
        uploads_count: z.number(),
        created_at: z.string(),
        updated_at: z.string(),
        app_url: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const ctx = getBasecampCtx(extra.authInfo?.extra);
      return handleGetVault(params, ctx);
    },
  );

  // ─── basecamp_list_subvaults ────────────────────────────────────────
  server.registerTool(
    'basecamp_list_subvaults',
    {
      title: 'List subvaults (subfolders) in a vault',
      description: `List the nested vaults (subfolders) inside a given vault.

Args:
  - project_id (number, required).
  - vault_id (number, required) — the parent vault.
  - limit, offset — standard pagination.
  - response_format ('markdown'|'json', default 'markdown').

Returns:
  Paginated envelope: { total, count, offset, has_more, next_offset, items: [{ id, title, status, documents_count, uploads_count, app_url }] }.

Examples:
  - Use when: you want to navigate a folder hierarchy.`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive().describe('Project ID.'),
          vault_id: z.number().int().positive().describe('Parent vault ID.'),
          ...paginationSchema,
          ...responseFormatSchema,
        })
        .strict().shape,
      outputSchema: {
        total: z.number(),
        count: z.number(),
        offset: z.number(),
        has_more: z.boolean(),
        next_offset: z.number().optional(),
        items: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const ctx = getBasecampCtx(extra.authInfo?.extra);
      return handleListSubvaults(params, ctx);
    },
  );

  // ─── basecamp_list_documents ────────────────────────────────────────
  server.registerTool(
    'basecamp_list_documents',
    {
      title: 'List documents in a vault',
      description: `List documents stored in a vault. Document body is NOT included — fetch it separately with basecamp_get_document.

Args:
  - project_id (number, required).
  - vault_id (number, required).
  - limit, offset — standard pagination.
  - response_format ('markdown'|'json', default 'markdown').

Returns:
  Paginated envelope: { total, count, offset, has_more, next_offset, items: [{ id, title, status, creator, created_at, updated_at, app_url }] }.

Note: CloudFile and GoogleDocument link cards are NOT returned here — use basecamp_search to surface all content types.`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive().describe('Project ID.'),
          vault_id: z.number().int().positive().describe('Vault ID.'),
          ...paginationSchema,
          ...responseFormatSchema,
        })
        .strict().shape,
      outputSchema: {
        total: z.number(),
        count: z.number(),
        offset: z.number(),
        has_more: z.boolean(),
        next_offset: z.number().optional(),
        items: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const ctx = getBasecampCtx(extra.authInfo?.extra);
      return handleListDocuments(params, ctx);
    },
  );

  // ─── basecamp_get_document ──────────────────────────────────────────
  server.registerTool(
    'basecamp_get_document',
    {
      title: 'Get a document with its full body',
      description: `Fetch one document including its full HTML content.

Args:
  - project_id (number, required).
  - document_id (number, required).
  - response_format ('markdown'|'json', default 'markdown').

Returns:
  { id, title, status, content (HTML), creator, created_at, updated_at, app_url }.
  In markdown format, HTML tags are stripped.

Examples:
  - Use when: "Show me the contents of the Architecture doc."`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive().describe('Project ID.'),
          document_id: z.number().int().positive().describe('Document ID.'),
          ...responseFormatSchema,
        })
        .strict().shape,
      outputSchema: {
        id: z.number(),
        title: z.string(),
        status: z.string(),
        content: z.string(),
        creator: z.record(z.string(), z.unknown()),
        created_at: z.string(),
        updated_at: z.string(),
        app_url: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const ctx = getBasecampCtx(extra.authInfo?.extra);
      return handleGetDocument(params, ctx);
    },
  );

  // ─── basecamp_list_uploads ──────────────────────────────────────────
  server.registerTool(
    'basecamp_list_uploads',
    {
      title: 'List uploads in a vault',
      description: `List file uploads stored in a vault.

Args:
  - project_id (number, required).
  - vault_id (number, required).
  - limit, offset — standard pagination.
  - response_format ('markdown'|'json', default 'markdown').

Returns:
  Paginated envelope: { total, count, offset, has_more, next_offset, items: [{ id, filename, content_type, byte_size, download_url, app_url, creator, created_at }] }.`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive().describe('Project ID.'),
          vault_id: z.number().int().positive().describe('Vault ID.'),
          ...paginationSchema,
          ...responseFormatSchema,
        })
        .strict().shape,
      outputSchema: {
        total: z.number(),
        count: z.number(),
        offset: z.number(),
        has_more: z.boolean(),
        next_offset: z.number().optional(),
        items: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const ctx = getBasecampCtx(extra.authInfo?.extra);
      return handleListUploads(params, ctx);
    },
  );

  // ─── basecamp_get_upload ────────────────────────────────────────────
  server.registerTool(
    'basecamp_get_upload',
    {
      title: 'Get upload metadata and download URL',
      description: `Fetch metadata for one upload including its pre-signed download URL.

Args:
  - project_id (number, required).
  - upload_id (number, required).
  - response_format ('markdown'|'json', default 'markdown').

Returns:
  { id, title, filename, content_type, byte_size, download_url, status, creator, created_at, updated_at, app_url }.

Note: MCP cannot return binary files. The download_url is a pre-signed link the caller can use to fetch the binary directly — this is the MCP-safe equivalent of downloading the file.`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive().describe('Project ID.'),
          upload_id: z.number().int().positive().describe('Upload ID.'),
          ...responseFormatSchema,
        })
        .strict().shape,
      outputSchema: {
        id: z.number(),
        title: z.string(),
        filename: z.string(),
        content_type: z.string(),
        byte_size: z.number(),
        download_url: z.string(),
        status: z.string(),
        creator: z.record(z.string(), z.unknown()),
        created_at: z.string(),
        updated_at: z.string(),
        app_url: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const ctx = getBasecampCtx(extra.authInfo?.extra);
      return handleGetUpload(params, ctx);
    },
  );

  // ─── basecamp_search ────────────────────────────────────────────────
  server.registerTool(
    'basecamp_search',
    {
      title: 'Search Basecamp account-wide',
      description: `Search across the entire Basecamp account (or scoped to one project).

Args:
  - query (string, required, min 1 char) — the search term.
  - project_id (number, optional) — scope search to one project.
  - limit (number, 1-100, default 20) — results per page.
  - page (number, default 1) — page number.
  - response_format ('markdown'|'json', default 'markdown').

Returns:
  { count, page, items: [{ id, type, title, content_excerpt, app_url, url, created_at, creator, parent, bucket }] }.

Critical: /search.json is the ONLY Basecamp endpoint that returns CloudFile (Loom, Netlify,
Excalidraw) and GoogleDocument link cards. Vault-scoped list endpoints (/vaults/{v}/documents.json
etc.) silently omit these types. Use search when you need to surface all content types in a project.

Examples:
  - "Find any Loom videos in project 42" → query="loom", project_id=42.
  - "Search for design docs" → query="design".`,
      inputSchema: z
        .object({
          query: z.string().min(1).describe('Search term.'),
          project_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Scope search to this project ID (omit for account-wide).'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_PAGE_LIMIT)
            .default(DEFAULT_PAGE_LIMIT)
            .describe('Results per page (1-100, default 20).'),
          page: z
            .number()
            .int()
            .min(1)
            .default(1)
            .describe('Page number (1-based).'),
          ...responseFormatSchema,
        })
        .strict().shape,
      outputSchema: {
        count: z.number(),
        page: z.number(),
        items: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      const ctx = getBasecampCtx(extra.authInfo?.extra);
      return handleSearch(params, ctx);
    },
  );
}
