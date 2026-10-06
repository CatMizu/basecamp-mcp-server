import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import rateLimit from 'express-rate-limit';
import { config } from '../../../config.js';
import { API_BASE_URL_PREFIX } from '../../../constants.js';
import { logger } from '../../shared/logger.js';
import { getBasecampAccessToken } from '../../auth/basecamp/client.js';
import { McpReauthError } from '../../auth/types.js';
import {
  isValidSgid,
  MAX_UPLOAD_BYTES,
  uploadStore,
  UploadStore,
  UploadTicket,
} from './store.js';

export interface UploadRouterOptions {
  store?: UploadStore;
  /** Basecamp token for the ticket owner's OAuth flow. Injectable for tests. */
  getAccessToken?: (flowId: string) => Promise<string>;
}

const NEXT_STEP =
  'Pass upload_id in the attachments param of basecamp_post_message, or use basecamp_create_vault_upload.';

/**
 * PUT /uploads/:secret — no bearer auth; the 256-bit secret in the path is a
 * one-time capability issued by basecamp_create_upload_url. The body is
 * streamed straight to Basecamp, never buffered: to the ticket's campfire
 * (chats/:id/uploads.json) when it has one, else to /attachments.json.
 *
 * Must be mounted BEFORE express.json()/urlencoded() so a client sending
 * `Content-Type: application/json` can't get the raw stream consumed.
 */
export function createUploadRouter(opts: UploadRouterOptions = {}): Router {
  const store = opts.store ?? uploadStore;
  const getAccessToken = opts.getAccessToken ?? getBasecampAccessToken;
  const router = Router();

  const uploadLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.put('/uploads/:secret', uploadLimiter, async (req: Request, res: Response) => {
    // Early rejections don't read the body; close the connection rather than
    // let Node try to drain up to 25 MB.
    const reject = (status: number, error: string) => {
      res.setHeader('Connection', 'close');
      res.status(status).json({ error });
    };

    const ticket = store.getBySecret(String(req.params.secret));
    if (!ticket) {
      return reject(404, 'Unknown upload URL. Request a new one with basecamp_create_upload_url.');
    }
    if (ticket.state !== 'pending') {
      return reject(409, 'This upload URL was already used. Request a new one with basecamp_create_upload_url.');
    }
    if (store.isExpired(ticket)) {
      return reject(410, 'This upload URL has expired. Request a new one with basecamp_create_upload_url.');
    }

    const lengthHeader = req.headers['content-length'];
    if (lengthHeader === undefined) {
      return reject(411, 'Content-Length is required (use curl --data-binary @file).');
    }
    const byteSize = Number(lengthHeader);
    if (!Number.isInteger(byteSize) || byteSize <= 0) {
      return reject(400, 'Content-Length must be a positive integer (empty files are not accepted).');
    }
    if (byteSize > MAX_UPLOAD_BYTES) {
      return reject(413, `File too large: ${byteSize} bytes (max ${MAX_UPLOAD_BYTES}).`);
    }

    // Single use from here on — a concurrent or repeated PUT gets 409.
    store.markUploading(ticket);

    try {
      const base = `${API_BASE_URL_PREFIX}/${ticket.owner.accountId}`;
      const name = encodeURIComponent(ticket.filename);
      if (ticket.campfire) {
        const { projectId, campfireId } = ticket.campfire;
        const line = (await forwardToBasecamp(
          ticket,
          byteSize,
          req,
          getAccessToken,
          `${base}/buckets/${projectId}/chats/${campfireId}/uploads.json?name=${name}`,
        )) as { id?: unknown; app_url?: unknown };
        if (typeof line.id !== 'number' || typeof line.app_url !== 'string') {
          throw new UploadForwardError(502, 'Basecamp returned an unexpected response.');
        }
        // Already posted — it can't be attached anywhere else.
        store.markUsed([ticket.id]);
        logger.info('Upload posted to campfire', { uploadId: ticket.id, byteSize });
        res.status(200).json({
          upload_id: ticket.id,
          filename: ticket.filename,
          byte_size: byteSize,
          status: 'posted',
          campfire_line_id: line.id,
          app_url: line.app_url,
        });
        return;
      }

      const body = (await forwardToBasecamp(
        ticket,
        byteSize,
        req,
        getAccessToken,
        `${base}/attachments.json?name=${name}`,
      )) as { attachable_sgid?: unknown };
      if (!isValidSgid(body.attachable_sgid)) {
        throw new UploadForwardError(502, 'Basecamp returned an unexpected response.');
      }
      store.markUploaded(ticket, body.attachable_sgid, byteSize);
      logger.info('Upload forwarded to Basecamp', { uploadId: ticket.id, byteSize });
      res.status(200).json({
        upload_id: ticket.id,
        filename: ticket.filename,
        byte_size: byteSize,
        status: 'uploaded',
        next: NEXT_STEP,
      });
    } catch (err) {
      store.markFailed(ticket);
      const failure =
        err instanceof UploadForwardError
          ? err
          : new UploadForwardError(502, 'Upload to Basecamp failed.');
      logger.warning('Upload to Basecamp failed', {
        uploadId: ticket.id,
        status: failure.status,
        reason: err instanceof Error ? err.message : String(err),
      });
      if (res.headersSent) return;
      if (failure.retryAfter !== undefined) {
        res.setHeader('Retry-After', String(failure.retryAfter));
      }
      res.setHeader('Connection', 'close');
      res.status(failure.status).json({
        error: `${failure.message} Request a new upload URL with basecamp_create_upload_url and try again.`,
      });
    }
  });

  return router;
}

class UploadForwardError extends Error {
  constructor(
    public status: number,
    msg: string,
    public retryAfter?: number,
  ) {
    super(msg);
    this.name = 'UploadForwardError';
  }
}

async function forwardToBasecamp(
  ticket: UploadTicket,
  byteSize: number,
  req: Request,
  getAccessToken: (flowId: string) => Promise<string>,
  url: string,
): Promise<unknown> {
  let token: string;
  try {
    token = await getAccessToken(ticket.owner.flowId);
  } catch (err) {
    if (err instanceof McpReauthError) {
      throw new UploadForwardError(502, 'Basecamp connector needs to be reconnected.');
    }
    throw err;
  }

  // The token only ever goes to 3.basecampapi.com (callers build url from API_BASE_URL_PREFIX).
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': `BasecampMCP (${config.userAgentContact})`,
      'Content-Type': ticket.contentType,
      'Content-Length': String(byteSize),
      Accept: 'application/json',
    },
    body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    duplex: 'half',
  } as RequestInit);

  if (upstream.status === 429) {
    const retryAfter = Number(upstream.headers.get('Retry-After') ?? '10');
    throw new UploadForwardError(
      429,
      'Basecamp rate limit hit.',
      Number.isFinite(retryAfter) ? retryAfter : 10,
    );
  }
  if (upstream.status === 401) {
    throw new UploadForwardError(502, 'Basecamp rejected the access token.');
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    throw new UploadForwardError(502, `Basecamp returned ${upstream.status}.`);
  }

  return upstream.json();
}
