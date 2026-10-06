import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import type { BasecampContext } from './auth-context.js';
import { handleMyNotifications } from './query-tools.js';
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

function makeResponse(body: unknown, status = 200): Response {
  return {
    status,
    statusText: 'OK',
    headers: new Headers(),
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

// Real /my/readings.json shape. The read entry mirrors the case this tool
// exists for: a reply-with-quote in a campfire surfaces here as an
// "@mentioned you" notification for the quoted author, while the chat-line
// API shows only the bare reply text.
const READINGS_FIXTURE = {
  unreads: [
    {
      id: 901,
      created_at: '2026-08-04T18:04:46.385Z',
      updated_at: '2026-08-04T18:04:46.385Z',
      section: 'inbox',
      unread_count: 1,
      unread_at: '2026-08-04T18:04:46.385Z',
      read_at: null,
      readable_sgid: 'sgid-901',
      title: 'Completed: 📊 Data Export & Reporting',
      type: 'Recording',
      bucket_name: 'YourPitch MVP',
      creator: { id: 51547260, name: 'Leyuan' },
      content_excerpt: 'Estimate: 8h',
      app_url: 'https://app.basecamp.com/9999/buckets/1/card_tables/cards/901',
    },
  ],
  reads: [
    {
      id: 902,
      created_at: '2026-08-04T21:11:51.580Z',
      updated_at: '2026-08-04T21:18:49.991Z',
      section: 'inbox',
      unread_count: 0,
      unread_at: null,
      read_at: '2026-08-04T21:18:49.991Z',
      readable_sgid: 'sgid-902',
      title: '@mentioned you: yes correct :) ',
      type: 'Recording',
      bucket_name: 'YourPitch MVP',
      creator: { id: 52251482, name: 'Esther Zeledon' },
      content_excerpt: 'yes correct :) ',
      app_url: 'https://app.basecamp.com/9999/buckets/1/chats/2@10166296701',
    },
  ],
  memories: [],
};

describe('notifications-tool', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('calls /my/readings.json with the page param', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(READINGS_FIXTURE));
    await handleMyNotifications(
      { page: 2, limit: 20, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/my/readings.json');
    expect(url).toContain('page=2');
  });

  test('surfaces the @mentioned-you reply attribution', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(READINGS_FIXTURE));
    const result = await handleMyNotifications(
      { page: 1, limit: 20, response_format: ResponseFormat.JSON },
      makeCtx(),
    );
    const struct = result.structuredContent as {
      unread_count: number;
      unreads: Array<Record<string, unknown>>;
      reads: Array<Record<string, unknown>>;
    };
    expect(struct.unread_count).toBe(1);
    expect(struct.unreads[0]).toMatchObject({
      state: 'unread',
      section: 'inbox',
      creator: { id: 51547260, name: 'Leyuan' },
    });
    expect(struct.reads[0]).toMatchObject({
      state: 'read',
      title: '@mentioned you: yes correct :) ',
      content_excerpt: 'yes correct :) ',
      creator: { id: 52251482, name: 'Esther Zeledon' },
      created_at: '2026-08-04T21:11:51.580Z',
    });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('@mentioned you: yes correct');
    expect(text).toContain('Esther Zeledon');
  });

  test('caps read items at limit', async () => {
    const many = {
      ...READINGS_FIXTURE,
      reads: Array.from({ length: 10 }, (_, i) => ({
        ...READINGS_FIXTURE.reads[0],
        id: 1000 + i,
      })),
    };
    fetchMock.mockResolvedValueOnce(makeResponse(many));
    const result = await handleMyNotifications(
      { page: 1, limit: 3, response_format: ResponseFormat.JSON },
      makeCtx(),
    );
    const struct = result.structuredContent as { reads: unknown[] };
    expect(struct.reads).toHaveLength(3);
  });

  test('returns error result on 404', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(undefined, 404));
    const result = await handleMyNotifications(
      { page: 1, limit: 20, response_format: ResponseFormat.MARKDOWN },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });
});
