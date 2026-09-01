import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, type McpServer } from '@modelcontextprotocol/server';
import express, { type Request, type Response } from 'express';
import { createBridgeMcpServer } from '../mcp/server.js';
import { LocalConnectorServer } from './connector.js';
import type { BridgeConfig, WorkspaceAdapter } from '../types.js';
import {
  bodyMethodName,
  type BridgeHttpAccessEvent,
  headerOriginHostname,
  headerUserAgent,
  parseRequestBodyLimit,
  RequestLimiter,
  RequestSecurity,
  requestLimits,
  writeJsonError,
} from './security.js';

export type { BridgeHttpAccessEvent } from './security.js';

interface McpSession {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
}

export interface BridgeHttpCarrier {
  readonly host: '127.0.0.1' | '0.0.0.0';
  readonly port: number;
  register(route: {
    kind: 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

export interface BridgeHttpServerOptions {
  config: BridgeConfig;
  adapter: WorkspaceAdapter;
  secretPath: string;
  bearerToken?: string | undefined;
  allowSecretPathOnly?: boolean | undefined;
  carrier?: BridgeHttpCarrier | undefined;
  localConnectorPort?: number | undefined;
  onAccessLog?: ((event: BridgeHttpAccessEvent) => void) | undefined;
}

export class BridgeHttpServer {
  readonly mcpPath: string;
  readonly healthPath: string;
  readonly oauthResourceMetadataPath: string;
  readonly oauthAuthorizationServerPath: string;
  readonly oauthAuthorizePath: string;
  readonly oauthTokenPath: string;
  readonly oauthRegisterPath: string;
  readonly security: RequestSecurity;
  private readonly sessions = new Map<string, McpSession>();
  private readonly limiter: RequestLimiter;
  private readonly oauthClients = new Map<string, { redirectUris: string[] }>();
  private readonly oauthCodes = new Map<string, {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    expiresAt: number;
  }>();
  private server: HttpServer | undefined;
  private listeningPort: number | undefined;
  private routeDisposer: (() => void) | undefined;
  readonly localConnector: LocalConnectorServer;

  constructor(private readonly options: BridgeHttpServerOptions) {
    this.mcpPath = `/mcp/${encodeURIComponent(options.secretPath)}`;
    this.healthPath = `${this.mcpPath}/health`;
    this.oauthResourceMetadataPath = `${this.mcpPath}/.well-known/oauth-protected-resource`;
    this.oauthAuthorizationServerPath = `${this.mcpPath}/.well-known/oauth-authorization-server`;
    this.oauthAuthorizePath = `${this.mcpPath}/oauth/authorize`;
    this.oauthTokenPath = `${this.mcpPath}/oauth/token`;
    this.oauthRegisterPath = `${this.mcpPath}/oauth/register`;
    this.security = new RequestSecurity(
      options.config.allowedOrigins,
      options.bearerToken,
      options.allowSecretPathOnly ?? false,
    );
    this.security.onAccessLog = options.onAccessLog;
    this.limiter = new RequestLimiter(
      options.config.limits.requestsPerMinute,
      options.config.limits.maxConcurrentRequests,
    );
    this.localConnector = new LocalConnectorServer(this);
  }

  get localOrigin(): string {
    if (this.listeningPort === undefined) {
      throw new Error('HTTP server is not running');
    }
    const host = this.options.carrier?.host === '0.0.0.0' || this.options.config.host === '0.0.0.0'
      ? '127.0.0.1'
      : this.options.carrier?.host ?? this.options.config.host;
    if (this.options.carrier && this.localConnector.running) {
      return `http://127.0.0.1:${this.localConnector.port}`;
    }
    return `http://${host}:${this.listeningPort}`;
  }

  get mcpUrl(): string {
    return `${this.localOrigin}${this.mcpPath}`;
  }

  oauthResourceMetadataUrl(requestOrigin: string): string {
    const origin = new URL(requestOrigin).origin;
    return `${origin}${this.oauthResourceMetadataPath}`;
  }

  private oauthResourceMetadataPayload(request: IncomingMessage): Record<string, unknown> {
    return {
      resource: `${nodeBaseUrl(request)}${this.mcpPath}`,
      authorization_servers: [nodeBaseUrl(request)],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${nodeBaseUrl(request)}${this.mcpPath}`,
    };
  }

  private setOAuthResourceMetadataFromRequest(req: IncomingMessage): void {
    const metadataUrl = this.oauthResourceMetadataUrl(nodeBaseUrl(req));
    if (this.security.bearerChallenge() !== `Bearer, resource_metadata="${metadataUrl}"`) {
      this.security.setOAuthResourceMetadata(metadataUrl);
    }
  }

  async start(): Promise<void> {
    if (this.server || this.routeDisposer) {
      return;
    }
    if (this.options.carrier) {
      this.routeDisposer = this.options.carrier.register({
        kind: 'prefix',
        path: this.mcpPath,
        handler: (req, res) => this.handleNodeRequest(req, res),
      });
      this.listeningPort = this.options.carrier.port;
      await this.localConnector.start(
        this.options.localConnectorPort ?? this.options.config.localConnectorPort ?? 0,
      );
      console.info('[dsh-browser-bridge] local connector started', {
        port: this.localConnector.port,
      });
      return;
    }

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: this.options.config.limits.requestBodyLimit }));
    app.use(express.urlencoded({ extended: false }));
    app.use(this.mcpPath, (req, _res, next) => {
      this.setOAuthResourceMetadataFromRequest(req);
      next();
    });
    app.use(this.mcpPath, (req, res, next) => {
      const fullPath = `${req.baseUrl}${req.path}`;
      if (!this.isOAuthPublicPath(fullPath)) {
        next();
        return;
      }
      this.security.applyCorsHeaders(req, res);
      const failure = this.security.authorize(req, { skipBearer: true });
      if (failure) {
        if (failure.authenticate) {
          res.setHeader('WWW-Authenticate', this.security.bearerChallenge());
        }
        res.status(failure.status).json({ error: failure.message });
        return;
      }
      if (req.method.toUpperCase() === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      void this.handleExpressOAuthRequest(req, res);
    });
    app.use(this.mcpPath, this.security.middleware());

    app.get(this.oauthResourceMetadataPath, (req, res) => {
      res.json(this.oauthResourceMetadataPayload(req));
    });

    app.get(this.healthPath, (_req, res) => {
      res.json({
        ok: true,
        protocol: 'streamable-http',
        sessions: this.sessions.size,
      });
    });
    app.post(
      this.mcpPath,
      requestLimits(
        this.options.config.limits.requestsPerMinute,
        this.options.config.limits.maxConcurrentRequests,
      ),
      (req, res) => {
        void this.handlePost(req, res);
      },
    );
    app.get(this.mcpPath, (req, res) => {
      void this.handleSessionVerb(req, res);
    });
    app.delete(this.mcpPath, (req, res) => {
      void this.handleSessionVerb(req, res);
    });

    this.server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(
        this.options.config.port,
        this.options.config.host,
        () => {
          this.server!.off('error', reject);
          const address = this.server!.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Unable to determine listening port'));
            return;
          }
          this.listeningPort = address.port;
          resolve();
        },
      );
    });
  }

  allowPublicOrigin(origin: string): void {
    this.security.allowPublicOrigin(origin);
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async ({ transport, server }) => {
      await Promise.allSettled([transport.close(), server.close()]);
    }));
    await this.localConnector.stop();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      this.listeningPort = undefined;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    this.routeDisposer?.();
    this.routeDisposer = undefined;
    this.listeningPort = undefined;
  }

  private async handlePost(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = req.headers['mcp-session-id'];
      const id = typeof sessionId === 'string' ? sessionId : undefined;
      if (id) {
        const session = this.sessions.get(id);
        if (!session) {
          jsonRpcError(res, 404, -32_001, 'Session not found');
          return;
        }
        await session.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32_000, 'Bad Request: initialization request required');
        return;
      }

      let session!: McpSession;
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          this.sessions.set(newSessionId, session);
        },
      });
      const server = createBridgeMcpServer(this.options.adapter, this.options.config);
      session = { transport, server };
      transport.onclose = () => {
        if (transport.sessionId) {
          this.sessions.delete(transport.sessionId);
        }
        void server.close();
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32_603, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async handleSessionVerb(req: Request, res: Response): Promise<void> {
    try {
      const header = req.headers['mcp-session-id'];
      const sessionId = typeof header === 'string' ? header : undefined;
      if (!sessionId) {
        res.status(400).send('Missing MCP-Session-Id');
        return;
      }
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.status(404).send('Session not found');
        return;
      }
      await session.transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).send(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const accessContext: { bodyMethod?: string } = {};
    this.setOAuthResourceMetadataFromRequest(req);
    this.logNodeAccess(req, res, accessContext);

    this.security.applyCorsHeaders(req, res);
    const isPreflight = req.method?.toUpperCase() === 'OPTIONS';
    const pathname = new URL(req.url ?? '/', 'http://bridge.local').pathname;
    if (this.isOAuthPublicPath(pathname)) {
      const failure = this.security.authorize(req, { skipBearer: true });
      if (failure) {
        writeJsonError(
          res,
          failure.status,
          failure.message,
          failure.authenticate ? this.security.bearerChallenge() : false,
        );
        return;
      }
      if (isPreflight) {
        res.writeHead(204);
        res.end();
        return;
      }
      await this.handleNodeOAuthRequest(req, res);
      return;
    }
    const failure = this.security.authorize(req, { skipBearer: isPreflight });
    if (failure) {
      writeJsonError(
        res,
        failure.status,
        failure.message,
        failure.authenticate ? this.security.bearerChallenge() : false,
      );
      return;
    }
    if (isPreflight) {
      res.writeHead(204);
      res.end();
      return;
    }

    const decision = this.limiter.begin(req);
    if (!decision.allowed) {
      writeJsonError(res, decision.status!, decision.message!);
      return;
    }
    res.once('finish', decision.release);
    res.once('close', decision.release);

    if (pathname === this.oauthResourceMetadataPath && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.oauthResourceMetadataPayload(req)));
      return;
    }
    if (pathname === this.healthPath && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        protocol: 'streamable-http',
        sessions: this.sessions.size,
      }));
      return;
    }
    if (pathname !== this.mcpPath) {
      writeJsonRpcErrorNode(res, 404, -32_001, 'Not Found');
      res.end();
      return;
    }

    try {
      if (req.method === 'POST') {
        const body = await this.readJsonBody(req);
        const bodyMethod = bodyMethodName(body);
        if (bodyMethod) {
          accessContext.bodyMethod = bodyMethod;
        }
        await this.handleNodePost(req, res, body);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        await this.handleNodeSessionVerb(req, res);
        return;
      }
      res.writeHead(405, { Allow: 'GET, POST, DELETE' });
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        writeJsonError(res, 500, error instanceof Error ? error.message : String(error));
      } else {
        res.destroy();
      }
    }
  }

  private logNodeAccess(
    req: IncomingMessage,
    res: ServerResponse,
    accessContext: { bodyMethod?: string },
  ): void {
    const startedAt = Date.now();
    const originAllowed = this.security.getAllowedCorsOrigin(req) !== undefined;
    const hasOrigin = Boolean(req.headers.origin);
    const hasAuthorization = Boolean(req.headers.authorization);
    const sessionHeader = req.headers['mcp-session-id'];
    const hasSessionId = typeof sessionHeader === 'string' && sessionHeader.length > 0;
    const origin = headerOriginHostname(req.headers.origin);
    const userAgent = headerUserAgent(req.headers['user-agent']);
    res.once('finish', () => {
      this.security.onAccessLog?.({
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
        ...(accessContext.bodyMethod ? { bodyMethod: accessContext.bodyMethod } : {}),
      });
    });
  }

  private async handleNodePost(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        writeJsonRpcErrorNode(res, 404, -32_001, 'Session not found');
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      writeJsonRpcErrorNode(res, 400, -32_000, 'Bad Request: initialization request required');
      return;
    }

    let session!: McpSession;
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        this.sessions.set(newSessionId, session);
      },
    });
    const server = createBridgeMcpServer(this.options.adapter, this.options.config);
    session = { transport, server };
    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
      void server.close();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private async handleNodeSessionVerb(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    if (!sessionId) {
      writeJsonError(res, 400, 'Missing MCP-Session-Id');
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      writeJsonError(res, 404, 'Session not found');
      return;
    }
    await session.transport.handleRequest(req, res);
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const maxBytes = parseRequestBodyLimit(this.options.config.limits.requestBodyLimit);
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new Error(`Request body exceeds ${maxBytes} bytes`);
      }
      chunks.push(buffer);
    }
    if (total === 0) {
      throw new Error('Request body is required');
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new Error('Request body must be valid JSON');
    }
  }

  private isOAuthPublicPath(pathname: string): boolean {
    return (
      pathname === this.oauthAuthorizationServerPath ||
      pathname === this.oauthAuthorizePath ||
      pathname === this.oauthTokenPath ||
      pathname === this.oauthRegisterPath
    );
  }

  private oauthAuthorizationServerPayload(request: IncomingMessage): Record<string, unknown> {
    const base = nodeBaseUrl(request);
    return {
      issuer: base,
      authorization_endpoint: `${base}${this.oauthAuthorizePath}`,
      token_endpoint: `${base}${this.oauthTokenPath}`,
      registration_endpoint: `${base}${this.oauthRegisterPath}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    };
  }

  private async handleExpressOAuthRequest(req: Request, res: Response): Promise<void> {
    try {
      await this.handleOAuthRequest(
        req,
        res,
        () => ({
          json: (body: unknown) => res.json(body),
          redirect: (url: string) => res.redirect(url),
          jsonError: (status: number, body: unknown) => {
            if (!res.headersSent) {
              res.status(status).json(body);
            }
          },
        }),
        new URL(req.originalUrl ?? req.url ?? '/', 'http://bridge.local').pathname,
        req.body,
      );
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async handleNodeOAuthRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.handleOAuthRequest(
        req,
        res,
        () => ({
          json: (body: unknown) => {
            if (!res.headersSent) {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            }
            res.end(JSON.stringify(body));
          },
          redirect: (url: string) => {
            if (!res.headersSent) {
              res.writeHead(302, { Location: url });
            }
            res.end();
          },
          jsonError: (status: number, body: unknown) => {
            if (!res.headersSent) {
              res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            }
            res.end(JSON.stringify(body));
          },
        }),
        new URL(req.url ?? '/', 'http://bridge.local').pathname,
        undefined,
      );
    } catch (error) {
      if (!res.headersSent) {
        writeJsonError(res, 500, error instanceof Error ? error.message : String(error));
      } else {
        res.destroy();
      }
    }
  }

  private async handleOAuthRequest(
    req: IncomingMessage,
    res: unknown,
    sink: () => {
      json: (body: unknown) => void;
      redirect: (url: string) => void;
      jsonError: (status: number, body: unknown) => void;
    },
    pathname: string,
    parsedBody: unknown,
  ): Promise<void> {
    if (pathname === this.oauthAuthorizationServerPath && req.method === 'GET') {
      sink().json(this.oauthAuthorizationServerPayload(req));
      return;
    }
    if (pathname === this.oauthRegisterPath && req.method === 'POST') {
      const body = parsedBody ?? (await this.readJsonBody(req));
      const redirectUris = parseRedirectUris(body);
      if (redirectUris.length === 0) {
        sink().jsonError(400, { error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
        return;
      }
      const clientId = randomBytes(16).toString('hex');
      this.oauthClients.set(clientId, { redirectUris });
      sink().json({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
      });
      return;
    }
    if (pathname === this.oauthAuthorizePath && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://bridge.local');
      const clientId = url.searchParams.get('client_id') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const codeChallenge = url.searchParams.get('code_challenge') ?? '';
      const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? 'plain';
      const client = this.oauthClients.get(clientId);
      if (!client || !client.redirectUris.includes(redirectUri)) {
        sink().jsonError(400, { error: 'invalid_client', error_description: 'Unknown client or redirect_uri' });
        return;
      }
      if (!codeChallenge || !['S256', 'plain'].includes(codeChallengeMethod)) {
        sink().jsonError(400, { error: 'invalid_request', error_description: 'code_challenge required' });
        return;
      }
      const code = randomBytes(24).toString('base64url');
      this.oauthCodes.set(code, {
        clientId,
        redirectUri,
        codeChallenge: `${codeChallengeMethod}:${codeChallenge}`,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      if (state) {
        target.searchParams.set('state', state);
      }
      sink().redirect(target.toString());
      return;
    }
    if (pathname === this.oauthTokenPath && req.method === 'POST') {
      let params: Map<string, string>;
      if (parsedBody !== undefined) {
        params = new Map<string, string>();
        for (const [key, value] of Object.entries(parsedBody as Record<string, unknown>)) {
          params.set(key, typeof value === 'string' ? value : String(value));
        }
      } else {
        params = await this.parseOAuthForm(req);
      }
      const grantType = params.get('grant_type');
      const code = params.get('code') ?? '';
      const codeVerifier = params.get('code_verifier') ?? '';
      const clientId = params.get('client_id') ?? '';
      const redirectUri = params.get('redirect_uri') ?? '';
      if (grantType !== 'authorization_code') {
        sink().jsonError(400, { error: 'unsupported_grant_type' });
        return;
      }
      const entry = this.oauthCodes.get(code);
      if (!entry || entry.expiresAt < Date.now()) {
        sink().jsonError(400, { error: 'invalid_grant', error_description: 'Invalid or expired code' });
        return;
      }
      this.oauthCodes.delete(code);
      if (entry.clientId !== clientId || entry.redirectUri !== redirectUri) {
        sink().jsonError(400, { error: 'invalid_grant', error_description: 'Code was issued to a different client or redirect_uri' });
        return;
      }
      const [method, expected] = splitChallenge(entry.codeChallenge);
      if (!verifyCodeChallenge(method, codeVerifier, expected)) {
        sink().jsonError(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      sink().json({
        access_token: this.options.bearerToken ?? '',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp',
      });
      return;
    }
    sink().jsonError(404, { error: 'not_found' });
  }

  private async parseOAuthForm(req: IncomingMessage): Promise<Map<string, string>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const params = new URLSearchParams(text);
    const result = new Map<string, string>();
    for (const [key, value] of params.entries()) {
      result.set(key, value);
    }
    return result;
  }
}

function nodeBaseUrl(request: IncomingMessage): string {
  const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['cf-forwarded-proto'];
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  const forwarded = proto ? `${proto}:` : undefined;
  const scheme =
    forwarded === 'https:' || forwarded === 'http:'
      ? forwarded
      : (request.socket as { encrypted?: boolean } | undefined)?.encrypted
        ? 'https:'
        : 'http:';
  const hostHeader = request.headers.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  try {
    return new URL(request.url ?? '/', `${scheme}//${host ?? 'bridge.local'}`).origin;
  } catch {
    return `${scheme}//bridge.local`;
  }
}

function parseRedirectUris(body: unknown): string[] {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const record = body as Record<string, unknown>;
  const uris = record.redirect_uris;
  if (!Array.isArray(uris)) {
    return [];
  }
  const result: string[] = [];
  for (const item of uris) {
    if (typeof item === 'string') {
      try {
        const parsed = new URL(item);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          result.push(parsed.toString());
        }
      } catch {
        // skip invalid
      }
    }
  }
  return result;
}

function splitChallenge(stored: string): [string, string] {
  const idx = stored.indexOf(':');
  if (idx === -1) {
    return ['plain', stored];
  }
  return [stored.slice(0, idx), stored.slice(idx + 1)];
}

function verifyCodeChallenge(method: string, verifier: string, expected: string): boolean {
  if (method === 'S256') {
    if (!verifier) {
      return false;
    }
    const digest = createHash('sha256').update(verifier).digest('base64url');
    return constantTimeEqual(digest, expected);
  }
  return constantTimeEqual(verifier, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function writeJsonRpcErrorNode(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }));
}

