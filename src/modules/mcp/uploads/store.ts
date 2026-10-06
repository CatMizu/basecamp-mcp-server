import crypto from 'crypto';

/**
 * In-memory upload tickets for the "send a local file" flow.
 *
 * The server can't read the user's disk, so a tool hands out a one-time
 * upload URL (`PUT /uploads/:secret`); the client PUTs the bytes there and
 * we stream them to Basecamp's attachments endpoint. The resulting
 * `attachable_sgid` stays here, keyed by a short public `upload_id`, until a
 * posting tool consumes it.
 *
 * In-memory is deliberate: production runs on a single Fly machine. A
 * restart drops pending/uploaded tickets — the client just requests a new
 * upload URL.
 */

export type UploadState = 'pending' | 'uploading' | 'uploaded' | 'used' | 'failed';

export interface UploadOwner {
  identityId: number;
  accountId: number;
  flowId: string;
}

export interface UploadTicket {
  /** Public short id, safe to show to the model. */
  id: string;
  /** 256-bit capability embedded in the upload URL. Never log it. */
  secret: string;
  owner: UploadOwner;
  filename: string;
  contentType: string;
  state: UploadState;
  sgid?: string;
  byteSize?: number;
  createdAt: number;
  expiresAt: number;
}

/** A pending upload URL is valid for this long. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** An uploaded file can be attached for this long. */
export const UPLOADED_TTL_MS = 60 * 60 * 1000;
/** Hard cap on tickets held in memory. */
export const MAX_TICKETS = 1000;
/** Largest file accepted by PUT /uploads/:secret. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Basecamp sgids are base64-ish tokens (letters, digits, `+/=_-`, and `--`
 * separators). Anything else is refused so an sgid can be interpolated into
 * an HTML attribute without escaping.
 */
const SGID_RE = /^[A-Za-z0-9+/=_-]{1,1024}$/;

export function isValidSgid(sgid: unknown): sgid is string {
  return typeof sgid === 'string' && SGID_RE.test(sgid);
}

export class UploadStore {
  private byId = new Map<string, UploadTicket>();
  private idBySecret = new Map<string, string>();

  constructor(private now: () => number = Date.now) {}

  create(owner: UploadOwner, filename: string, contentType: string): UploadTicket {
    this.gc();
    if (this.byId.size >= MAX_TICKETS) {
      throw new Error('Too many uploads in progress. Try again in a few minutes.');
    }
    const createdAt = this.now();
    const ticket: UploadTicket = {
      id: 'up_' + crypto.randomBytes(8).toString('hex'),
      secret: crypto.randomBytes(32).toString('hex'),
      owner: { ...owner },
      filename,
      contentType,
      state: 'pending',
      createdAt,
      expiresAt: createdAt + PENDING_TTL_MS,
    };
    this.byId.set(ticket.id, ticket);
    this.idBySecret.set(ticket.secret, ticket.id);
    return ticket;
  }

  /** Lookup by URL secret. Returns expired tickets too — callers check `isExpired`. */
  getBySecret(secret: string): UploadTicket | undefined {
    const id = this.idBySecret.get(secret);
    return id ? this.byId.get(id) : undefined;
  }

  getById(id: string): UploadTicket | undefined {
    return this.byId.get(id);
  }

  isExpired(ticket: UploadTicket): boolean {
    return this.now() >= ticket.expiresAt;
  }

  markUploading(ticket: UploadTicket): void {
    ticket.state = 'uploading';
  }

  markUploaded(ticket: UploadTicket, sgid: string, byteSize: number): void {
    ticket.state = 'uploaded';
    ticket.sgid = sgid;
    ticket.byteSize = byteSize;
    ticket.expiresAt = this.now() + UPLOADED_TTL_MS;
  }

  markFailed(ticket: UploadTicket): void {
    ticket.state = 'failed';
  }

  markUsed(ids: string[]): void {
    for (const id of ids) {
      const t = this.byId.get(id);
      if (t) t.state = 'used';
    }
  }

  /**
   * Resolve upload_ids for a posting tool. Every id must exist, be in state
   * 'uploaded', be unexpired, and belong to the caller's account + identity.
   * Throws with a model-readable message on the first bad id.
   */
  resolveForOwner(
    ids: string[],
    caller: { identityId: number; accountId: number },
  ): UploadTicket[] {
    return ids.map((id) => {
      const t = this.byId.get(id);
      if (
        !t ||
        t.owner.accountId !== caller.accountId ||
        t.owner.identityId !== caller.identityId
      ) {
        throw new Error(
          `Unknown upload_id "${id}". Call basecamp_create_upload_url and upload the file first.`,
        );
      }
      if (t.state === 'used') {
        throw new Error(`upload_id "${id}" was already attached. Upload the file again.`);
      }
      if (t.state !== 'uploaded' || !t.sgid) {
        throw new Error(
          `upload_id "${id}" has no uploaded file (state: ${t.state}). Run the curl upload first, or request a new upload URL.`,
        );
      }
      if (this.isExpired(t)) {
        throw new Error(`upload_id "${id}" has expired. Upload the file again.`);
      }
      return t;
    });
  }

  size(): number {
    return this.byId.size;
  }

  /** Drop expired tickets. In-flight uploads are kept until they settle. */
  private gc(): void {
    const now = this.now();
    for (const [id, t] of this.byId) {
      if (t.state !== 'uploading' && now >= t.expiresAt) {
        this.byId.delete(id);
        this.idBySecret.delete(t.secret);
      }
    }
  }
}

/** Process-wide store. Tests construct their own UploadStore. */
export const uploadStore = new UploadStore();
