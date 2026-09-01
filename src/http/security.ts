import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function constantTimeEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(digest(actual), digest(expected));
}

function hostnameFromHeader(host: string | undefined): string | undefined {
  if (!host) {
    return undefined;
  }
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeHostname(value: string): string | undefined {
  try {
    const parsed = new URL(value.includes('://') ? value : `http://${value}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function normalizeOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export interface BridgeRequestLike {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  socket?: {
    remoteAddress?: string | undefined;
  } | undefined;
}

export interface SecurityFailure {
  status: 401 | 403;
  message: string;
  authenticate?: boolean;
}

export interface BridgeHttpAccessEvent {
  method: string | undefined;
  status: number;
  reason: string;
  durationMs: number;
  hasOrigin: boolean;
  originAllowed: boolean;
  hasAuthorization: boolean;
  hasSessionId: boolean;
  /** Hostname of the Origin header when present; never the full origin URL. */
  origin?: string | undefined;
  /** Truncated User-Agent header, stripped of control characters. */
  userAgent?: string | undefined;
  /** MCP JSON-RPC method name (initialize, tools/list, ...) when known. */
  bodyMethod?: string | undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function headerOriginHostname(
  value: string | string[] | undefined,
): string | undefined {
  const header = headerValue(value);
  if (!header) {
    return undefined;
  }
  try {
    const parsed = new URL(header);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function headerUserAgent(
  value: string | string[] | undefined,
): string | undefined {
  const header = headerValue(value);
  if (!header) {
    return undefined;
  }
  return header.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
}

export function bodyMethodName(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' && method.length > 0 ? method : undefined;
}

interface HeaderWriter {
  setHeader(name: string, value: string): void;
}

export function parseRequestBodyLimit(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) {
    throw new Error(`Invalid request body limit: "${value}"`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier = unit === 'gb'
    ? 1024 ** 3
    : unit === 'mb'
      ? 1024 ** 2
      : unit === 'kb'
        ? 1024
        : 1;
  const bytes = Math.floor(amount * multiplier);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`Invalid request body limit: "${value}"`);
  }
  return bytes;
}

export class RequestSecurity {
  onAccessLog?: ((event: BridgeHttpAccessEvent) => void) | undefined;

  private readonly allowedHosts = new Set<string>(['localhost', '127.0.0.1', '[::1]', '::1']);
  private readonly allowedOrigins: Set<string>;

  constructor(
    allowedOrigins: string[],
    private readonly bearerToken?: string,
    private readonly allowSecretPathOnly = false,
  ) {
    this.allowedOrigins = new Set(
      allowedOrigins
        .map(normalizeOrigin)
        .filter((origin): origin is string => origin !== undefined),
    );
  }

  allowPublicOrigin(origin: string): void {
    const hostname = normalizeHostname(origin);
    const normalizedOrigin = normalizeOrigin(origin);
    if (hostname) {
      this.allowedHosts.add(hostname);
    }
    if (normalizedOrigin) {
      this.allowedOrigins.add(normalizedOrigin);
    }
  }

  getAllowedCorsOrigin(request: BridgeRequestLike): string | undefined {
    const origin = headerValue(request.headers.origin);
    if (!origin) {
      return undefined;
    }
    const normalizedOrigin = normalizeOrigin(origin);
    return normalizedOrigin && this.allowedOrigins.has(normalizedOrigin)
      ? normalizedOrigin
      : undefined;
  }

  applyCorsHeaders(request: BridgeRequestLike, response: HeaderWriter): boolean {
    const allowedOrigin = this.getAllowedCorsOrigin(request);
    if (!allowedOrigin) {
      return false;
    }

    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (request.method?.toUpperCase() === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
      );
      if (headerValue(request.headers['access-control-request-private-network'])?.toLowerCase() === 'true') {
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }
    return true;
  }

  authorize(
    request: BridgeRequestLike,
    options: { skipBearer?: boolean } = {},
  ): SecurityFailure | undefined {
    const hostname = hostnameFromHeader(headerValue(request.headers.host));
    if (!hostname || !this.allowedHosts.has(hostname)) {
      return { status: 403, message: 'Host header is not allowed' };
    }

    const origin = headerValue(request.headers.origin);
    if (origin) {
      if (!this.getAllowedCorsOrigin(request)) {
        return { status: 403, message: 'Origin is not allowed' };
      }
    }

    if (request.method?.toUpperCase() === 'OPTIONS' && !this.getAllowedCorsOrigin(request)) {
      return { status: 403, message: 'CORS origin is not allowed' };
    }

    if (this.bearerToken && !options.skipBearer) {
      const authorization = headerValue(request.headers.authorization);
      if (this.allowSecretPathOnly && authorization === undefined) {
        return undefined;
      }
      const actual = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
      if (!constantTimeEqual(actual, this.bearerToken)) {
        return {
          status: 401,
          message: 'Missing or invalid bearer token',
          authenticate: true,
        };
      }
    }
    return undefined;
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      const startedAt = Date.now();
      const originAllowed = this.getAllowedCorsOrigin(req) !== undefined;
      const hasOrigin = Boolean(req.headers.origin);
      const hasAuthorization = Boolean(req.headers.authorization);
      const sessionHeader = req.headers['mcp-session-id'];
      const hasSessionId = typeof sessionHeader === 'string' && sessionHeader.length > 0;
      const origin = headerOriginHostname(req.headers.origin);
      const userAgent = headerUserAgent(req.headers['user-agent']);
      const bodyMethod = bodyMethodName(req.body);
      res.once('finish', () => {
        this.onAccessLog?.({
          method: req.method,
          status: res.statusCode,
          reason: 'response',
          durationMs: Date.now() - startedAt,
          hasOrigin,
          originAllowed,
          hasAuthorization,
          hasSessionId,
          ...(origin ? { origin } : {}),
          ...(userAgent ? { userAgent } : {}),
          ...(bodyMethod ? { bodyMethod } : {}),
        });
      });
      this.applyCorsHeaders(req, res);
      const isPreflight = req.method.toUpperCase() === 'OPTIONS';
      const failure = this.authorize(req, { skipBearer: isPreflight });
      if (failure) {
        if (failure.authenticate) {
          res.setHeader('WWW-Authenticate', 'Bearer');
        }
        res.status(failure.status).json({ error: failure.message });
        return;
      }
      if (isPreflight) {
        res.status(204).end();
        return;
      }
      next();
    };
  }
}

interface RateLimitDecision {
  allowed: boolean;
  status?: 429 | 503;
  message?: string;
  release(): void;
}

export class RequestLimiter {
  private readonly clients = new Map<string, { windowStartedAt: number; requests: number }>();
  private concurrent = 0;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly maxConcurrentRequests: number,
  ) {}

  begin(request: BridgeRequestLike): RateLimitDecision {
    const now = Date.now();
    const key = headerValue(request.headers['x-forwarded-for'])
      ?? request.socket?.remoteAddress
      ?? 'unknown';
    const current = this.clients.get(key);
    const record = !current || now - current.windowStartedAt >= 60_000
      ? { windowStartedAt: now, requests: 0 }
      : current;
    record.requests += 1;
    this.clients.set(key, record);

    if (record.requests > this.requestsPerMinute) {
      return {
        allowed: false,
        status: 429,
        message: 'Request rate limit exceeded',
        release: () => undefined,
      };
    }
    if (this.concurrent >= this.maxConcurrentRequests) {
      return {
        allowed: false,
        status: 503,
        message: 'Too many concurrent requests',
        release: () => undefined,
      };
    }

    this.concurrent += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (!released) {
          released = true;
          this.concurrent -= 1;
        }
      },
    };
  }
}

export function requestLimits(
  requestsPerMinute: number,
  maxConcurrentRequests: number,
): RequestHandler {
  const limiter = new RequestLimiter(requestsPerMinute, maxConcurrentRequests);

  return (req: Request, res: Response, next: NextFunction): void => {
    const decision = limiter.begin(req);
    if (!decision.allowed) {
      res.status(decision.status!).json({ error: decision.message });
      return;
    }

    res.once('finish', decision.release);
    res.once('close', decision.release);
    res.once('finish', () => res.off('close', decision.release));
    next();
  };
}

export function writeJsonError(
  res: ServerResponse,
  status: number,
  message: string,
  authenticate = false,
): void {
  if (authenticate) {
    res.setHeader('WWW-Authenticate', 'Bearer');
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

export type BridgeNodeRequest = IncomingMessage;
