import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import type { BasecampContext } from './auth-context.js';
import {
  handleCreateUploadUrl,
  handleCreateVaultUpload,
  inferContentType,
} from './upload-tools.js';
import { handlePostCampfireMessage, handlePostMessage } from './action-tools.js';
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

const CHAT_LINE = {
  id: 77,
  content: 'hi',
  created_at: '2026-10-06T00:00:00Z',
  app_url: 'https://3.basecamp.com/9999/buckets/42/chats/5@77',
  creator: { id: 1, name: 'Me' },
};

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

  test('campfire: attachments are appended as bc-attachment and ids marked used', async () => {
    const a = uploaded(store, 'SGID-A');
    const b = uploaded(store, 'SGID-B');
    fetchMock.mockResolvedValueOnce(makeResponse(CHAT_LINE, 201));
    const result = await handlePostCampfireMessage(
      {
        project_id: 42,
        campfire_id: 5,
        content: 'Here you go',
        attachments: [a.id, b.id],
        response_format: ResponseFormat.JSON,
      },
      makeCtx(),
      store,
    );
    expect(result.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://3.basecampapi.com/9999/buckets/42/chats/5/lines.json');
    expect(JSON.parse(init.body as string)).toEqual({
      content:
        'Here you go<bc-attachment sgid="SGID-A"></bc-attachment><bc-attachment sgid="SGID-B"></bc-attachment>',
      content_type: 'text/html',
    });
    expect(store.getById(a.id)?.state).toBe('used');
    expect(store.getById(b.id)?.state).toBe('used');
  });

  test('campfire: attachments alone are enough (no content)', async () => {
    const a = uploaded(store, 'SGID-A');
    fetchMock.mockResolvedValueOnce(makeResponse(CHAT_LINE, 201));
    const result = await handlePostCampfireMessage(
      { project_id: 42, campfire_id: 5, attachments: [a.id], response_format: ResponseFormat.JSON },
      makeCtx(),
      store,
    );
    expect(result.isError).toBeFalsy();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).content).toBe(
      '<bc-attachment sgid="SGID-A"></bc-attachment>',
    );
  });

  test('campfire: neither content nor attachments is an error', async () => {
    const result = await handlePostCampfireMessage(
      { project_id: 42, campfire_id: 5, response_format: ResponseFormat.JSON },
      makeCtx(),
      store,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/content, attachments/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('campfire: without attachments the request is unchanged', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(CHAT_LINE, 201));
    await handlePostCampfireMessage(
      { project_id: 42, campfire_id: 5, content: 'Standup in 5', response_format: ResponseFormat.JSON },
      makeCtx(),
      store,
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      content: 'Standup in 5',
      content_type: 'text/html',
    });
  });

  test('campfire: a foreign-owner upload_id posts nothing', async () => {
    const mine = uploaded(store, 'SGID-MINE');
    const theirs = store.create({ identityId: 2, accountId: 9999, flowId: 'flow-2' }, 'b.png', 'image/png');
    store.markUploaded(theirs, 'SGID-THEIRS', 10);
    const result = await handlePostCampfireMessage(
      {
        project_id: 42,
        campfire_id: 5,
        content: 'hi',
        attachments: [mine.id, theirs.id],
        response_format: ResponseFormat.JSON,
      },
      makeCtx(),
      store,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Unknown upload_id/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getById(mine.id)?.state).toBe('uploaded');
  });

  test('campfire: a used upload_id is rejected on reuse', async () => {
    const a = uploaded(store, 'SGID-A');
    fetchMock.mockResolvedValue(makeResponse(CHAT_LINE, 201));
    const params = {
      project_id: 42,
      campfire_id: 5,
      attachments: [a.id],
      response_format: ResponseFormat.JSON,
    };
    expect((await handlePostCampfireMessage(params, makeCtx(), store)).isError).toBeFalsy();
    const again = await handlePostCampfireMessage(params, makeCtx(), store);
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/already attached/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('campfire: a failed post leaves the upload reusable', async () => {
    const a = uploaded(store, 'SGID-A');
    fetchMock.mockResolvedValueOnce(makeResponse({ error: 'nope' }, 422));
    const result = await handlePostCampfireMessage(
      { project_id: 42, campfire_id: 5, attachments: [a.id], response_format: ResponseFormat.JSON },
      makeCtx(),
      store,
    );
    expect(result.isError).toBe(true);
    expect(store.getById(a.id)?.state).toBe('uploaded');
  });

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
