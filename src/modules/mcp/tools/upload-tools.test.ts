import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import type { BasecampContext } from './auth-context.js';
import {
  handleCreateUploadUrl,
  handleCreateVaultUpload,
  inferContentType,
} from './upload-tools.js';
import { handlePostMessage } from './action-tools.js';
import { ResponseFormat } from '../../../constants.js';
import { MAX_UPLOAD_BYTES, UploadStore } from '../uploads/store.js';

const originalFetch = globalThis.fetch;

function makeCtx(overrides: Partial<BasecampContext> = {}): BasecampContext {
  return {
    identityId: 1,
    accountId: 9999,
    flowId: 'flow-1',
    apiBaseUrl: 'https://3.basecampapi.com/9999',
    getAccessToken: async () => 'bearer-token',
    ...overrides,
  };
}

function makeResponse(body: unknown, status = 200): Response {
  return {
    status,
    statusText: 'OK',
    headers: new Headers(),
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

/** An 'uploaded' ticket owned by makeCtx()'s user. */
function uploaded(store: UploadStore, sgid = 'SGID-AAA', filename = 'a.png') {
  const t = store.create({ identityId: 1, accountId: 9999, flowId: 'flow-1' }, filename, 'image/png');
  store.markUploading(t);
  store.markUploaded(t, sgid, 10);
  return t;
}

describe('upload-tools', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;
  let store: UploadStore;

  beforeEach(() => {
    fetchMock = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    store = new UploadStore();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ─── basecamp_create_upload_url ───────────────────────────────────────

  test('inferContentType maps known extensions and falls back to octet-stream', () => {
    expect(inferContentType('Shot.PNG')).toBe('image/png');
    expect(inferContentType('report.pdf')).toBe('application/pdf');
    expect(inferContentType('deck.pptx')).toMatch(/presentationml/);
    expect(inferContentType('binary')).toBe('application/octet-stream');
    expect(inferContentType('x.unknown')).toBe('application/octet-stream');
  });

  test('handleCreateUploadUrl returns a one-time URL and curl template', async () => {
    const result = await handleCreateUploadUrl(
      { filename: 'chart.png', response_format: ResponseFormat.JSON },
      makeCtx(),
      store,
      'https://mcp.example.com/',
    );
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, string | number>;
    const ticket = store.getById(s.upload_id as string)!;
    expect(ticket.contentType).toBe('image/png');
    expect(ticket.owner).toEqual({ identityId: 1, accountId: 9999, flowId: 'flow-1' });
    expect(s.upload_url).toBe(`https://mcp.example.com/uploads/${ticket.secret}`);
    expect(s.max_bytes).toBe(MAX_UPLOAD_BYTES);
    expect(s.expires_at).toBe(new Date(ticket.expiresAt).toISOString());
    expect(s.curl_command).toBe(
      `curl -sS --fail-with-body -X PUT -H "Content-Type: image/png" --data-binary @"<LOCAL_FILE_PATH>" "https://mcp.example.com/uploads/${ticket.secret}"`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('handleCreateUploadUrl honours an explicit content_type', async () => {
    const result = await handleCreateUploadUrl(
      { filename: 'data.bin', content_type: 'text/plain', response_format: ResponseFormat.JSON },
      makeCtx(),
      store,
      'https://mcp.example.com',
    );
    const s = result.structuredContent as Record<string, string>;
    expect(store.getById(s.upload_id)?.contentType).toBe('text/plain');
  });

  test('handleCreateUploadUrl markdown tells the model to use an absolute path', async () => {
    const result = await handleCreateUploadUrl(
      { filename: 'a.png', response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
      store,
      'https://mcp.example.com',
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('absolute path');
    expect(text).toContain('no ~');
  });

  test('handleCreateUploadUrl stores a campfire target and says the file posts on upload', async () => {
    const result = await handleCreateUploadUrl(
      { filename: 'a.png', project_id: 42, campfire_id: 5, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
      store,
      'https://mcp.example.com',
    );
    expect(result.isError).toBeFalsy();
    const id = /upload_id: (up_[0-9a-f]+)/.exec(textOf(result))![1];
    expect(store.getById(id)?.campfire).toEqual({ projectId: 42, campfireId: 5 });
    expect(textOf(result)).toContain('basecamp_post_campfire_message BEFORE running curl');
    expect(textOf(result)).not.toContain('attachments');
  });

  test('handleCreateUploadUrl without a target stores none', async () => {
    const result = await handleCreateUploadUrl(
      { filename: 'a.png', response_format: ResponseFormat.JSON },
      makeCtx(),
      store,
      'https://mcp.example.com',
    );
    const s = result.structuredContent as Record<string, string>;
    expect(store.getById(s.upload_id)?.campfire).toBeUndefined();
  });

  test.each([
    { project_id: 42 },
    { campfire_id: 5 },
  ])('handleCreateUploadUrl rejects a half campfire target %o', async (half) => {
    const result = await handleCreateUploadUrl(
      { filename: 'a.png', ...half, response_format: ResponseFormat.JSON },
      makeCtx(),
      store,
      'https://mcp.example.com',
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/project_id and campfire_id together/);
    expect(store.size()).toBe(0);
  });

  // ─── basecamp_create_vault_upload ─────────────────────────────────────

  test('handleCreateVaultUpload posts attachable_sgid to the vault and marks the id used', async () => {
    const t = uploaded(store, 'SGID-VAULT');
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        { id: 500, title: 'Report', filename: 'a.png', app_url: 'https://3.basecamp.com/9999/buckets/42/uploads/500' },
        201,
      ),
    );
    const result = await handleCreateVaultUpload(
      {
        project_id: 42,
        vault_id: 10,
        upload_id: t.id,
        description: '<div>Q3</div>',
        base_name: 'Report',
        response_format: ResponseFormat.JSON,
      },
      makeCtx(),
      store,
    );
    expect(result.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://3.basecampapi.com/9999/buckets/42/vaults/10/uploads.json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      attachable_sgid: 'SGID-VAULT',
      description: '<div>Q3</div>',
      base_name: 'Report',
    });
    expect(result.structuredContent).toEqual({
      id: 500,
      title: 'Report',
      filename: 'a.png',
      app_url: 'https://3.basecamp.com/9999/buckets/42/uploads/500',
    });
    expect(store.getById(t.id)?.state).toBe('used');
  });

  test('handleCreateVaultUpload rejects a foreign upload_id without calling Basecamp', async () => {
    const t = uploaded(store);
    const result = await handleCreateVaultUpload(
      { project_id: 42, vault_id: 10, upload_id: t.id, response_format: ResponseFormat.JSON },
      makeCtx({ accountId: 1234 }),
      store,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Unknown upload_id/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getById(t.id)?.state).toBe('uploaded');
  });

  // ─── attachments on posting tools ─────────────────────────────────────

  test('message board: attachments appended to content and ids marked used', async () => {
    const a = uploaded(store, 'SGID-MSG');
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          id: 42,
          dock: [
            {
              name: 'message_board',
              enabled: true,
              url: 'https://3.basecampapi.com/9999/buckets/42/message_boards/3.json',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse(
          { id: 88, subject: 'Q3', app_url: 'https://3.basecamp.com/9999/buckets/42/messages/88' },
          201,
        ),
      );
    const result = await handlePostMessage(
      {
        project_id: 42,
        subject: 'Q3',
        content: '<div>See attached</div>',
        status: 'active',
        attachments: [a.id],
        response_format: ResponseFormat.JSON,
      },
      makeCtx(),
      store,
    );
    expect(result.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://3.basecampapi.com/9999/buckets/42/message_boards/3/messages.json');
    expect(JSON.parse(init.body as string)).toEqual({
      subject: 'Q3',
      content: '<div>See attached</div><bc-attachment sgid="SGID-MSG"></bc-attachment>',
      status: 'active',
    });
    expect(store.getById(a.id)?.state).toBe('used');
  });

  test.each([
    ['active', { status: 'active' }],
    ['draft', {}],
  ] as const)('message board: status %s sends %o', async (status, expected) => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          id: 42,
          dock: [
            {
              name: 'message_board',
              enabled: true,
              url: 'https://3.basecampapi.com/9999/buckets/42/message_boards/3.json',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResponse(
          { id: 88, subject: 'Q3', app_url: 'https://3.basecamp.com/9999/buckets/42/messages/88' },
          201,
        ),
      );
    const result = await handlePostMessage(
      { project_id: 42, subject: 'Q3', content: 'x', status, response_format: ResponseFormat.JSON },
      makeCtx(),
      store,
    );
    expect(result.isError).toBeFalsy();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ subject: 'Q3', content: 'x', ...expected });
  });

  test('message board: unknown upload_id posts nothing (not even the project lookup)', async () => {
    const result = await handlePostMessage(
      {
        project_id: 42,
        subject: 'Q3',
        content: 'x',
        status: 'active',
        attachments: ['up_0000000000000000'],
        response_format: ResponseFormat.JSON,
      },
      makeCtx(),
      store,
    );
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
