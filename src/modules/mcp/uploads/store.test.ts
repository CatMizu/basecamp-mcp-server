import { describe, test, expect } from '@jest/globals';
import {
  isValidSgid,
  MAX_TICKETS,
  PENDING_TTL_MS,
  UPLOADED_TTL_MS,
  UploadStore,
} from './store.js';

const OWNER = { identityId: 1, accountId: 9999, flowId: 'flow-1' };

function makeStore(start = 1_000_000) {
  let now = start;
  const store = new UploadStore(() => now);
  return { store, advance: (ms: number) => (now += ms) };
}

describe('UploadStore', () => {
  test('create issues a public id and a 256-bit secret, looked up by secret', () => {
    const { store } = makeStore();
    const t = store.create(OWNER, 'chart.png', 'image/png');
    expect(t.id).toMatch(/^up_[0-9a-f]{16}$/);
    expect(t.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(t.state).toBe('pending');
    expect(t.expiresAt - t.createdAt).toBe(PENDING_TTL_MS);
    expect(store.getBySecret(t.secret)).toBe(t);
    expect(store.getById(t.id)).toBe(t);
    expect(store.getBySecret('nope')).toBeUndefined();
  });

  test('pending ticket expires after 10 minutes and is GC-ed on next create', () => {
    const { store, advance } = makeStore();
    const t = store.create(OWNER, 'a.txt', 'text/plain');
    advance(PENDING_TTL_MS - 1);
    expect(store.isExpired(t)).toBe(false);
    advance(1);
    expect(store.isExpired(t)).toBe(true);
    store.create(OWNER, 'b.txt', 'text/plain');
    expect(store.getBySecret(t.secret)).toBeUndefined();
    expect(store.size()).toBe(1);
  });

  test('in-flight uploads survive GC', () => {
    const { store, advance } = makeStore();
    const t = store.create(OWNER, 'a.txt', 'text/plain');
    store.markUploading(t);
    advance(PENDING_TTL_MS + 1);
    store.create(OWNER, 'b.txt', 'text/plain');
    expect(store.getById(t.id)).toBe(t);
  });

  test('uploaded ticket is resolvable for 60 minutes, then expires', () => {
    const { store, advance } = makeStore();
    const t = store.create(OWNER, 'a.png', 'image/png');
    store.markUploading(t);
    store.markUploaded(t, 'SGID123', 42);
    expect(store.resolveForOwner([t.id], OWNER)).toEqual([t]);
    advance(UPLOADED_TTL_MS);
    expect(() => store.resolveForOwner([t.id], OWNER)).toThrow(/expired/);
  });

  test('resolveForOwner rejects foreign account or identity as unknown', () => {
    const { store } = makeStore();
    const t = store.create(OWNER, 'a.png', 'image/png');
    store.markUploaded(t, 'SGID123', 42);
    expect(() =>
      store.resolveForOwner([t.id], { identityId: 1, accountId: 1234 }),
    ).toThrow(/Unknown upload_id/);
    expect(() =>
      store.resolveForOwner([t.id], { identityId: 2, accountId: 9999 }),
    ).toThrow(/Unknown upload_id/);
  });

  test('resolveForOwner rejects pending, failed and used tickets', () => {
    const { store } = makeStore();
    const pending = store.create(OWNER, 'a.png', 'image/png');
    expect(() => store.resolveForOwner([pending.id], OWNER)).toThrow(/state: pending/);

    const failed = store.create(OWNER, 'b.png', 'image/png');
    store.markFailed(failed);
    expect(() => store.resolveForOwner([failed.id], OWNER)).toThrow(/state: failed/);

    const used = store.create(OWNER, 'c.png', 'image/png');
    store.markUploaded(used, 'SGID', 1);
    store.markUsed([used.id]);
    expect(() => store.resolveForOwner([used.id], OWNER)).toThrow(/already attached/);
  });

  test('cap bounds memory', () => {
    const { store } = makeStore();
    for (let i = 0; i < MAX_TICKETS; i++) store.create(OWNER, 'f.txt', 'text/plain');
    expect(() => store.create(OWNER, 'f.txt', 'text/plain')).toThrow(/Too many uploads/);
  });

  test('isValidSgid accepts base64-ish tokens and rejects attribute injection', () => {
    expect(isValidSgid('BAh7CEkiCGdpZAY6BkVUSSIr--a1b2c3=')).toBe(true);
    expect(isValidSgid('abc" onload="x')).toBe(false);
    expect(isValidSgid('a<b')).toBe(false);
    expect(isValidSgid('')).toBe(false);
    expect(isValidSgid(undefined)).toBe(false);
  });
});
