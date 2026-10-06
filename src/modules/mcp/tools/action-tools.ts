import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ResponseFormat } from '../../../constants.js';
import type {
  BasecampChatLine,
  BasecampMessage,
  BasecampProject,
  BasecampTodo,
} from '../../../lib/types.js';
import { bcFetch } from './basecamp-api.js';
import { getBasecampCtx } from './auth-context.js';
import type { BasecampContext } from './auth-context.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { uploadStore, UploadStore } from '../uploads/store.js';
import { attachmentHtml, resolveAttachments } from './upload-tools.js';
import {
  buildResult,
  findDock,
  toolError,
} from './utils.js';

const formatParam = {
  response_format: z
    .nativeEnum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe('"markdown" for human-readable, "json" for programmatic.'),
};

const attachmentsParam = {
  attachments: z
    .array(z.string())
    .min(1)
    .max(10)
    .optional()
    .describe('upload_ids from basecamp_create_upload_url (after the curl upload succeeded).'),
};

// ─── Exported handlers (testable without McpServer) ────────────────────────

export async function handlePostMessage(
  params: {
    project_id: number;
    subject: string;
    content: string;
    status: 'active' | 'draft';
    attachments?: string[];
    response_format: ResponseFormat;
  },
  ctx: BasecampContext,
  store: UploadStore = uploadStore,
): Promise<CallToolResult> {
  try {
    // Resolve before any Basecamp call so a bad upload_id posts nothing.
    const uploads = params.attachments
      ? resolveAttachments(params.attachments, ctx, store)
      : [];
    const project = await bcFetch<BasecampProject>(
      ctx,
      `/projects/${params.project_id}.json`,
    );
    const board = findDock(project, 'message_board');
    if (!board?.enabled || !board.url) {
      return toolError(
        new Error(`Project ${params.project_id} has no enabled message board.`),
      );
    }
    const postUrl = board.url.replace(/\.json$/, '/messages.json');
    const m = await bcFetch<BasecampMessage>(ctx, postUrl, {
      method: 'POST',
      body: {
        subject: params.subject,
        content: params.content + attachmentHtml(uploads),
        status: params.status,
      },
    });
    store.markUsed(uploads.map((u) => u.id));
    const struct = { id: m.id, subject: m.subject, app_url: m.app_url };
    return buildResult(
      `Posted message #${m.id}: **${m.subject}**\n${m.app_url}`,
      struct,
      params.response_format,
    );
  } catch (err) {
    return toolError(err);
  }
}

export async function handlePostCampfireMessage(
  params: {
    project_id: number;
    campfire_id: number;
    content?: string;
    attachments?: string[];
    response_format: ResponseFormat;
  },
  ctx: BasecampContext,
  store: UploadStore = uploadStore,
): Promise<CallToolResult> {
  try {
    if (!params.content && !params.attachments?.length) {
      return toolError(new Error('Provide content, attachments, or both.'));
    }
    // Resolve before any Basecamp call so a bad upload_id posts nothing.
    const uploads = params.attachments
      ? resolveAttachments(params.attachments, ctx, store)
      : [];
    const line = await bcFetch<BasecampChatLine>(
      ctx,
      `/buckets/${params.project_id}/chats/${params.campfire_id}/lines.json`,
      {
        method: 'POST',
        body: {
          content: (params.content ?? '') + attachmentHtml(uploads),
          content_type: 'text/html', // load-bearing — see SKILL docs
        },
      },
    );
    store.markUsed(uploads.map((u) => u.id));
    const struct = {
      id: line.id,
      content: line.content,
      created_at: line.created_at,
      app_url: line.app_url,
    };
    return buildResult(
      `Sent campfire line #${line.id}.\n${line.app_url}`,
      struct,
      params.response_format,
    );
  } catch (err) {
    return toolError(err);
  }
}

export function registerActionTools(server: McpServer): void {
  // ─── basecamp_create_todo ───────────────────────────────────────────
  server.registerTool(
    'basecamp_create_todo',
    {
      title: 'Create a todo',
      description: `Create a todo in an existing todolist.

Args:
  - project_id (number, required).
  - todolist_id (number, required) — from basecamp_list_todolists.
  - title (string, required, 1-500 chars).
  - description (string, optional) — rich-text HTML body.
  - assignee_ids (array<number>, optional) — use basecamp_list_project_people to find IDs.
  - due_on (string 'YYYY-MM-DD', optional).
  - notify (boolean, optional, default false) — whether Basecamp pings assignees.
  - response_format ('markdown'|'json').

Returns:
  The created todo: { id, title, completed, due_on, app_url }.

Examples:
  - Use when: "Add 'Prep launch deck' to the Launch Checklist, due Friday, assign Alice."

Error handling:
  - 422 from Basecamp usually means the description HTML has disallowed tags.`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive(),
          todolist_id: z.number().int().positive(),
          title: z.string().min(1).max(500),
          description: z.string().optional(),
          assignee_ids: z.array(z.number().int().positive()).optional(),
          due_on: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
            .optional(),
          notify: z.boolean().default(false),
          ...formatParam,
        })
        .strict().shape,
      outputSchema: {
        id: z.number(),
        title: z.string(),
        completed: z.boolean(),
        due_on: z.string().nullable(),
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
        const body: Record<string, unknown> = {
          content: params.title,
          notify: params.notify,
        };
        if (params.description) body.description = params.description;
        if (params.assignee_ids?.length) body.assignee_ids = params.assignee_ids;
        if (params.due_on) body.due_on = params.due_on;
        const t = await bcFetch<BasecampTodo>(
          ctx,
          `/buckets/${params.project_id}/todolists/${params.todolist_id}/todos.json`,
          { method: 'POST', body },
        );
        const struct = {
          id: t.id,
          title: t.title,
          completed: !!t.completed,
          due_on: t.due_on,
          app_url: t.app_url,
        };
        const markdown = `Created todo #${t.id}: **${t.title}**\n${t.app_url}`;
        return buildResult(markdown, struct, params.response_format);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ─── basecamp_complete_todo ─────────────────────────────────────────
  server.registerTool(
    'basecamp_complete_todo',
    {
      title: 'Mark a todo complete',
      description: `Mark a todo as completed.

Args:
  - project_id (number, required).
  - todo_id (number, required).
  - response_format ('markdown'|'json').

Returns:
  { id, completed: true }.

Examples:
  - Use when: "Mark 'Deploy to staging' as done."

Error handling:
  - 404 → todo doesn't exist or was trashed.`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive(),
          todo_id: z.number().int().positive(),
          ...formatParam,
        })
        .strict().shape,
      outputSchema: {
        id: z.number(),
        completed: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params, extra) => {
      try {
        const ctx = getBasecampCtx(extra.authInfo?.extra);
        // POST /buckets/{bucket}/todos/{id}/completion.json — returns 204 No Content.
        await bcFetch<void>(
          ctx,
          `/buckets/${params.project_id}/todos/${params.todo_id}/completion.json`,
          { method: 'POST' },
        );
        const struct = { id: params.todo_id, completed: true };
        return buildResult(
          `Marked todo #${params.todo_id} as complete.`,
          struct,
          params.response_format,
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ─── basecamp_post_message ──────────────────────────────────────────
  server.registerTool(
    'basecamp_post_message',
    {
      title: 'Post a message to a project message board',
      description: `Post a new message to the given project's message board.

The content body is treated as HTML. Allowed tags: div, h1, br, strong, em,
strike, a (with href), pre, ol, ul, li, blockquote.

**@mentions:** To mention a person, get their \`attachable_sgid\` from basecamp_list_project_people, then insert:
  <bc-attachment sgid="THEIR_SGID" content-type="application/vnd.basecamp.mention"></bc-attachment>

Args:
  - project_id (number, required).
  - subject (string, required).
  - content (string, required) — HTML body.
  - status ('active' | 'draft', default 'active').
  - attachments (array<string>, optional, 1-10) — upload_ids from basecamp_create_upload_url; each file is appended to the body. One-time use.
  - response_format ('markdown'|'json').

Returns:
  { id, subject, app_url }.

Examples:
  - Use when: "Post a weekly update with subject 'Week 14 status'."
`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive(),
          subject: z.string().min(1).max(500),
          content: z.string().min(1),
          status: z.enum(['active', 'draft']).default('active'),
          ...attachmentsParam,
          ...formatParam,
        })
        .strict().shape,
      outputSchema: {
        id: z.number(),
        subject: z.string(),
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
        return handlePostMessage(params, ctx);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ─── basecamp_post_campfire_message ─────────────────────────────────
  server.registerTool(
    'basecamp_post_campfire_message',
    {
      title: 'Send a campfire chat message',
      description: `Send a message to a Basecamp campfire.

**Important:** Basecamp requires \`content_type: "text/html"\` for rich
messages — this tool injects it automatically so your newlines render
correctly. Include HTML (\`<br>\`, \`<strong>\`, etc.) in content for formatting.

**@mentions:** To mention a person, get their \`attachable_sgid\` from basecamp_list_project_people, then insert:
  <bc-attachment sgid="THEIR_SGID" content-type="application/vnd.basecamp.mention"></bc-attachment>

**Threading:** Basecamp campfire does not support threaded replies via the API.

Args:
  - project_id (number, required).
  - campfire_id (number, required) — from basecamp_list_campfires.
  - content (string, optional) — HTML body. Required unless attachments is given.
  - attachments (array<string>, optional, 1-10) — upload_ids from basecamp_create_upload_url; each file is appended to the message. One-time use.
  - response_format ('markdown'|'json').

Returns:
  { id, content, created_at, app_url }.

Examples:
  - Use when: "Post 'Standup in 5' to the engineering campfire."
  - Use when: "Send this screenshot to the campfire" — upload it with basecamp_create_upload_url first, then pass attachments.
`,
      inputSchema: z
        .object({
          project_id: z.number().int().positive(),
          campfire_id: z.number().int().positive(),
          content: z.string().min(1).optional(),
          ...attachmentsParam,
          ...formatParam,
        })
        .strict().shape,
      outputSchema: {
        id: z.number(),
        content: z.string(),
        created_at: z.string(),
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
        return handlePostCampfireMessage(params, ctx);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
