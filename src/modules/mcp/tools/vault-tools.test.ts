import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import type { BasecampContext } from './auth-context.js';
import {
  handleGetVault,
  handleListSubvaults,
  handleListDocuments,
  handleGetDocument,
  handleListUploads,
  handleGetUpload,
  handleSearch,
} from './vault-tools.js';
import { ResponseFormat } from '../../../constants.js';

const originalFetch = globalThis.fetch;

function makeCtx(): BasecampContext {
  return {
    identityId: 1,
    accountId: 9999,
    flowId: 'flow-1',
    apiBaseUrl: 'https://3.basecampapi.com/9999',
    getAccessToken: async () => 'bearer-token',
  };
}

function makeResponse({
  status = 200,
  body,
  headers = {},
}: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  const headersMap = new Headers(headers);
  return {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: headersMap,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

describe('vault-tools', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ─── basecamp_get_vault ───────────────────────────────────────────────

  test('handleGetVault calls correct URL and returns vault struct', async () => {
    const vault = {
      id: 10,
      status: 'active',
      title: 'Assets',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      documents_count: 3,
      uploads_count: 5,
      url: 'https://3.basecampapi.com/9999/buckets/42/vaults/10.json',
      app_url: 'https://3.basecamp.com/9999/buckets/42/vaults/10',
      parent: null,
      bucket: { id: 42, name: 'My Project', type: 'Project' },
    };
    fetchMock.mockResolvedValueOnce(makeResponse({ body: vault }));
    const result = await handleGetVault(
      { project_id: 42, vault_id: 10, response_format: ResponseFormat.JSON },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/buckets/42/vaults/10.json');
    const content = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(content.id).toBe(10);
    expect(content.documents_count).toBe(3);
  });

  test('handleGetVault returns error result on 404', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 404 }));
    const result = await handleGetVault(
      { project_id: 42, vault_id: 999, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  // ─── basecamp_list_subvaults ──────────────────────────────────────────

  test('handleListSubvaults calls correct URL and returns paginated items', async () => {
    const vaults = [
      {
        id: 20,
        status: 'active',
        title: 'Designs',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        documents_count: 1,
        uploads_count: 0,
        url: 'u',
        app_url: 'https://3.basecamp.com/9999/buckets/42/vaults/20',
        parent: null,
        bucket: { id: 42, name: 'My Project', type: 'Project' },
      },
    ];
    fetchMock.mockResolvedValueOnce(makeResponse({ body: vaults }));
    const result = await handleListSubvaults(
      { project_id: 42, vault_id: 10, limit: 20, offset: 0, response_format: ResponseFormat.JSON },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/buckets/42/vaults/10/vaults.json');
    const content = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(content.items).toHaveLength(1);
    expect(content.items[0].id).toBe(20);
  });

  test('handleListSubvaults returns error result on 404', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 404 }));
    const result = await handleListSubvaults(
      { project_id: 42, vault_id: 999, limit: 20, offset: 0, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  // ─── basecamp_list_documents ──────────────────────────────────────────

  test('handleListDocuments calls correct URL and items do NOT include content', async () => {
    const docs = [
      {
        id: 30,
        status: 'active',
        title: 'Spec',
        content: '<p>Secret body</p>',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        creator: { id: 1, name: 'Alice' },
        url: 'u',
        app_url: 'https://3.basecamp.com/9999/buckets/42/documents/30',
        parent: { id: 10, title: 'Assets', url: 'u', app_url: 'a', type: 'Vault' },
        bucket: { id: 42, name: 'My Project', type: 'Project' },
      },
    ];
    fetchMock.mockResolvedValueOnce(makeResponse({ body: docs }));
    const result = await handleListDocuments(
      { project_id: 42, vault_id: 10, limit: 20, offset: 0, response_format: ResponseFormat.JSON },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/buckets/42/vaults/10/documents.json');
    const content = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(content.items[0]).not.toHaveProperty('content');
  });

  test('handleListDocuments returns error result on 404', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 404 }));
    const result = await handleListDocuments(
      { project_id: 42, vault_id: 999, limit: 20, offset: 0, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  // ─── basecamp_get_document ────────────────────────────────────────────

  test('handleGetDocument returns content in structuredContent and strips HTML in markdown', async () => {
    const doc = {
      id: 30,
      status: 'active',
      title: 'Spec',
      content: '<div>Hello <b>World</b></div>',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      creator: { id: 1, name: 'Alice' },
      url: 'u',
      app_url: 'https://3.basecamp.com/9999/buckets/42/documents/30',
      parent: { id: 10, title: 'Assets', url: 'u', app_url: 'a', type: 'Vault' },
      bucket: { id: 42, name: 'My Project', type: 'Project' },
    };
    fetchMock.mockResolvedValueOnce(makeResponse({ body: doc }));
    const result = await handleGetDocument(
      { project_id: 42, document_id: 30, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Record<string, unknown>)?.content).toBe(
      '<div>Hello <b>World</b></div>',
    );
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain('<div>');
  });

  test('handleGetDocument returns error result on 404', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 404 }));
    const result = await handleGetDocument(
      { project_id: 42, document_id: 999, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  // ─── basecamp_list_uploads ────────────────────────────────────────────

  test('handleListUploads calls correct URL and returns upload items', async () => {
    const uploads = [
      {
        id: 50,
        status: 'active',
        title: 'logo.png',
        filename: 'logo.png',
        content_type: 'image/png',
        byte_size: 12345,
        download_url: 'https://example.com/dl/logo.png',
        url: 'u',
        app_url: 'https://3.basecamp.com/9999/buckets/42/uploads/50',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        creator: { id: 1, name: 'Alice' },
        parent: { id: 10, title: 'Assets', url: 'u', app_url: 'a', type: 'Vault' },
        bucket: { id: 42, name: 'My Project', type: 'Project' },
      },
    ];
    fetchMock.mockResolvedValueOnce(makeResponse({ body: uploads }));
    const result = await handleListUploads(
      { project_id: 42, vault_id: 10, limit: 20, offset: 0, response_format: ResponseFormat.JSON },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/buckets/42/vaults/10/uploads.json');
    const content = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(content.items[0].filename).toBe('logo.png');
  });

  test('handleListUploads returns error result on 404', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 404 }));
    const result = await handleListUploads(
      { project_id: 42, vault_id: 999, limit: 20, offset: 0, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  // ─── basecamp_get_upload ──────────────────────────────────────────────

  test('handleGetUpload calls correct URL and returns download_url', async () => {
    const upload = {
      id: 50,
      status: 'active',
      title: 'logo.png',
      filename: 'logo.png',
      content_type: 'image/png',
      byte_size: 12345,
      download_url: 'https://example.com/dl/logo.png',
      url: 'u',
      app_url: 'https://3.basecamp.com/9999/buckets/42/uploads/50',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      creator: { id: 1, name: 'Alice' },
      parent: { id: 10, title: 'Assets', url: 'u', app_url: 'a', type: 'Vault' },
      bucket: { id: 42, name: 'My Project', type: 'Project' },
    };
    fetchMock.mockResolvedValueOnce(makeResponse({ body: upload }));
    const result = await handleGetUpload(
      { project_id: 42, upload_id: 50, response_format: ResponseFormat.JSON },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/buckets/42/uploads/50.json');
    const content = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(content.download_url).toBe('https://example.com/dl/logo.png');
  });

  test('handleGetUpload returns error result on 404', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 404 }));
    const result = await handleGetUpload(
      { project_id: 42, upload_id: 999, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  // ─── basecamp_search ──────────────────────────────────────────────────

  test('handleSearch URL contains q, per_page, and page params', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: [] }));
    await handleSearch(
      { query: 'design', limit: 10, page: 2, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('q=design');
    expect(url).toContain('per_page=10');
    expect(url).toContain('page=2');
  });

  test('handleSearch includes bucket param when project_id is provided', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: [] }));
    await handleSearch(
      { query: 'loom', project_id: 42, limit: 20, page: 1, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('bucket=42');
  });

  test('handleSearch omits bucket param when project_id is not provided', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: [] }));
    await handleSearch(
      { query: 'loom', limit: 20, page: 1, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('bucket=');
  });

  test('handleSearch returns error result on 404', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 404 }));
    const result = await handleSearch(
      { query: 'x', limit: 20, page: 1, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });
});
