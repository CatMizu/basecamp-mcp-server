import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { logger } from '../../shared/logger.js';
import { McpReauthError } from '../../auth/types.js';
import { createUploadRouter } from './route.js';
import { MAX_UPLOAD_BYTES, PENDING_TTL_MS, UploadStore } from './store.js';

const OWNER = { identityId: 1, accountId: 9999, flowId: 'flow-1' };
const originalFetch = globalThis.fetch;

interface PutResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** PUT via node http (globalThis.fetch is mocked as the Basecamp upstream). */
function put(
  port: number,
  path: string,
  opts: { body?: Buffer; headers?: Record<string, string>; chunked?: boolean } = {},
): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'image/png', ...opts.headers };
    if (opts.body && !opts.chunked && !headers['Content-Length']) {
      headers['Content-Length'] = String(opts.body.length);
    }
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'PUT', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data ? (JSON.parse(data) as Record<string, unknown>) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function readStream(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('PUT /uploads/:secret', () => {
  let now: number;
  let store: UploadStore;
  let server: http.Server;
  let port: number;
  let fetchMock: jest.MockedFunction<typeof fetch>;
  let received: Buffer | undefined;
  let getAccessToken: (flowId: string) => Promise<string>;

  beforeEach(async () => {
    now = 1_000_000;
    store = new UploadStore(() => now);
    received = undefined;
    getAccessToken = async () => 'bc-access-token';
    fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      received = await readStream(init?.body);
      return new Response(JSON.stringify({ attachable_sgid: 'BAh7SGID--abc=' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as jest.MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;

    const app = express();
    app.use(logger.middleware());
    app.use(
      '/',
      createUploadRouter({ store, getAccessToken: (flowId) => getAccessToken(flowId) }),
    );
    // Mirrors src/index.ts: body parsers mounted after the upload router.
    app.use(express.json());
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((r) => server.close(() => r()));
  });

  test('404 for an unknown secret', async () => {
    const res = await put(port, '/uploads/deadbeef', { body: Buffer.from('x') });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('410 for an expired ticket', async () => {
    const t = store.create(OWNER, 'a.png', 'image/png');
    now += PENDING_TTL_MS;
    const res = await put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') });
    expect(res.status).toBe(410);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('411 without Content-Length (chunked)', async () => {
    const t = store.create(OWNER, 'a.png', 'image/png');
    const res = await put(port, `/uploads/${t.secret}`, {
      body: Buffer.from('abc'),
      chunked: true,
    });
    expect(res.status).toBe(411);
    expect(store.getById(t.id)?.state).toBe('pending');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('413 when Content-Length exceeds 25 MB, without reading the body', async () => {
    const t = store.create(OWNER, 'a.png', 'image/png');
    const res = await put(port, `/uploads/${t.secret}`, {
      headers: { 'Content-Length': String(MAX_UPLOAD_BYTES + 1) },
    });
    expect(res.status).toBe(413);
    expect(store.getById(t.id)?.state).toBe('pending');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('success streams bytes to Basecamp with the right request shape', async () => {
    const t = store.create(OWNER, 'my chart.png', 'image/png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    const res = await put(port, `/uploads/${t.secret}`, { body: bytes });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      upload_id: t.id,
      filename: 'my chart.png',
      byte_size: bytes.length,
      status: 'uploaded',
      next: expect.stringContaining('attachments'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://3.basecampapi.com/9999/attachments.json?name=my%20chart.png');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer bc-access-token');
    expect(headers['User-Agent']).toMatch(/^BasecampMCP \(/);
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Content-Length']).toBe(String(bytes.length));
    expect(received).toEqual(bytes);

    const stored = store.getById(t.id);
    expect(stored?.state).toBe('uploaded');
    expect(stored?.sgid).toBe('BAh7SGID--abc=');
    expect(stored?.byteSize).toBe(bytes.length);
  });

  test('raw body is intact even when the client claims application/json', async () => {
    const t = store.create(OWNER, 'data.json', 'application/json');
    const bytes = Buffer.from('{"a":1}');
    const res = await put(port, `/uploads/${t.secret}`, {
      body: bytes,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(received).toEqual(bytes);
  });

  test('single use: a second PUT is rejected', async () => {
    const t = store.create(OWNER, 'a.png', 'image/png');
    expect((await put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') })).status).toBe(200);
    const second = await put(port, `/uploads/${t.secret}`, { body: Buffer.from('y') });
    expect(second.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a concurrent PUT is rejected while the first upload is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let called!: () => void;
    const fetchStarted = new Promise<void>((r) => (called = r));
    fetchMock.mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
      called();
      await gate;
      received = await readStream(init?.body);
      return new Response(JSON.stringify({ attachable_sgid: 'BAh7SGID--abc=' }), { status: 201 });
    });
    const t = store.create(OWNER, 'a.png', 'image/png');
    const first = put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') });
    await fetchStarted;

    const second = await put(port, `/uploads/${t.secret}`, { body: Buffer.from('y') });
    expect(second.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getById(t.id)?.state).toBe('uploading');

    release();
    expect((await first).status).toBe(200);
    expect(store.getById(t.id)?.state).toBe('uploaded');
  });

  test('McpReauthError from the token fetch maps to 502 and fails the ticket', async () => {
    getAccessToken = async () => {
      throw new McpReauthError('refresh failed');
    };
    const t = store.create(OWNER, 'a.png', 'image/png');
    const res = await put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/reconnect/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getById(t.id)?.state).toBe('failed');
  });

  test('an unexpected token-fetch error maps to a generic 502 and fails the ticket', async () => {
    getAccessToken = async () => {
      throw new Error('db exploded: secret detail');
    };
    const t = store.create(OWNER, 'a.png', 'image/png');
    const res = await put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/^Upload to Basecamp failed\./);
    expect(res.body.error).not.toContain('db exploded');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getById(t.id)?.state).toBe('failed');
  });

  test('Basecamp 429 passes through with Retry-After and fails the ticket', async () => {
    fetchMock.mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
      await readStream(init?.body);
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } });
    });
    const t = store.create(OWNER, 'a.png', 'image/png');
    const res = await put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.body.error).toMatch(/new upload URL/);
    expect(store.getById(t.id)?.state).toBe('failed');
  });

  test('Basecamp 401 maps to 502', async () => {
    fetchMock.mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
      await readStream(init?.body);
      return new Response('', { status: 401 });
    });
    const t = store.create(OWNER, 'a.png', 'image/png');
    const res = await put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') });
    expect(res.status).toBe(502);
    expect(store.getById(t.id)?.state).toBe('failed');
  });

  test('an invalid sgid from Basecamp is refused', async () => {
    fetchMock.mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
      await readStream(init?.body);
      return new Response(JSON.stringify({ attachable_sgid: 'x" onclick="y' }), { status: 201 });
    });
    const t = store.create(OWNER, 'a.png', 'image/png');
    const res = await put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') });
    expect(res.status).toBe(502);
    expect(store.getById(t.id)?.sgid).toBeUndefined();
  });

  test('neither the URL secret nor the Basecamp token is logged', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const t = store.create(OWNER, 'a.png', 'image/png');
      await put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') });
      await put(port, `/uploads/${t.secret}`, { body: Buffer.from('x') });
      // Express routing is case-insensitive, so redaction must be too.
      const t2 = store.create(OWNER, 'b.png', 'image/png');
      expect((await put(port, `/UPLOADS/${t2.secret}`, { body: Buffer.from('x') })).status).toBe(200);
      // The 'close' log line fires after the response is flushed.
      await new Promise((r) => setTimeout(r, 20));
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('/uploads/[redacted]');
      expect(output).not.toContain(t.secret);
      expect(output).not.toContain(t2.secret);
      expect(output).not.toContain('bc-access-token');
    } finally {
      logSpy.mockRestore();
    }
  });
});
