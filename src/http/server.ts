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
import {
  createAccessToken,
  OAuthPersistentClientStore,
  OAuthRefreshTokenStore,
  type SecretStoreLike,
  verifyAccessToken,
} from './oauth-tokens.js';
import type { OAuthPairingCode } from '../types.js';
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
  requestBaseUrl,
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
    kind: 'path' | 'prefix';
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
  statelessMcp?: boolean | undefined;
  carrier?: BridgeHttpCarrier | undefined;
  localConnectorPort?: number | undefined;
  localPairingToken?: string | undefined;
  oauthSigningKey?: string | undefined;
  oauthSecretStore?: SecretStoreLike | undefined;
  onAccessLog?: ((event: BridgeHttpAccessEvent) => void) | undefined;
}

const OAUTH_CLIENTS_SECRET = 'oauth-clients';
const OAUTH_REFRESH_TOKENS_SECRET = 'oauth-refresh-tokens';
const LOCAL_PAIRING_TOKEN_SECRET = 'local-pairing-token';

export class BridgeHttpServer {
  readonly mcpPath: string;
  readonly healthPath: string;
  readonly oauthResourceMetadataPath: string;
  readonly oauthProtectedResourceIndexPath: string;
  readonly oauthAuthorizationServerPath: string;
  readonly oauthAuthorizePath: string;
  readonly oauthTokenPath: string;
 readonly oauthRegisterPath: string;
  readonly oauthRevokePath: string;
  readonly security: RequestSecurity;
  private readonly oauthSigningKey: string;
  private readonly localPairingToken: string;
  private readonly sessions = new Map<string, McpSession>();
  private publicOrigin: string | null = null;
  private readonly limiter: RequestLimiter;
  private readonly oauthClients: OAuthPersistentClientStore;
  private readonly oauthCodes = new Map<string, {
    clientId: string;
    redirectUri: string;
    codeChallengeMethod: string;
    codeChallenge: string;
    resource: string;
    issuer: string;
    scopes: string[];
    expiresAt: number;
  }>();
  private readonly oauthPairingCodes = new Map<string, number>();
  private readonly pendingAuthorizeRequests = new Map<string, {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scopes: string[];
    resource: string;
    issuer: string;
    expiresAt: number;
  }>();
  private readonly oauthRefreshTokens: OAuthRefreshTokenStore;
  private server: HttpServer | undefined;
  private listeningPort: number | undefined;
  private routeDisposers: Array<() => void> = [];
  readonly localConnector: LocalConnectorServer;

  constructor(private readonly options: BridgeHttpServerOptions) {
    this.mcpPath = `/mcp/${encodeURIComponent(options.secretPath)}`;
    this.healthPath = `${this.mcpPath}/health`;
    this.oauthResourceMetadataPath = `${this.mcpPath}/.well-known/oauth-protected-resource`;
    this.oauthProtectedResourceIndexPath = `/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(options.secretPath)}`;
    this.oauthAuthorizationServerPath = '/.well-known/oauth-authorization-server';
    this.oauthAuthorizePath = '/oauth/authorize';
    this.oauthTokenPath = '/oauth/token';
   this.oauthRegisterPath = '/oauth/register';
    this.oauthRevokePath = '/oauth/revoke';
    this.oauthSigningKey = options.oauthSigningKey ?? randomBytes(32).toString('base64url');
    this.localPairingToken = options.localPairingToken ?? randomBytes(32).toString('base64url');
    this.oauthClients = new OAuthPersistentClientStore(
      options.oauthSecretStore,
      OAUTH_CLIENTS_SECRET,
    );
    this.oauthRefreshTokens = new OAuthRefreshTokenStore(
      options.oauthSecretStore,
      OAUTH_REFRESH_TOKENS_SECRET,
    );
    this.security = new RequestSecurity(
      options.config.allowedOrigins,
      options.bearerToken,
      options.allowSecretPathOnly ?? false,
      (token, issuer) => this.verifyOAuthAccessToken(token, issuer),
    );
    this.security.onAccessLog = options.onAccessLog;
    this.limiter = new RequestLimiter(
      options.config.limits.requestsPerMinute,
      options.config.limits.maxConcurrentRequests,
    );
    this.localConnector = new LocalConnectorServer(this, this.localPairingToken);
  }

  getLocalPairingToken(): string {
    return this.localPairingToken;
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

  oauthResourceMetadataUrl(requestOrigin?: string): string {
    const origin = requestOrigin
      ? new URL(requestOrigin).origin
      : (this.publicOrigin ?? 'http://127.0.0.1');
    return `${origin}${this.oauthProtectedResourceIndexPath}`;
  }

  private oauthResourceMetadataPayload(
    request: IncomingMessage,
    resourcePath = this.mcpPath,
  ): Record<string, unknown> {
    const base = this.effectiveBaseUrl(request);
    return {
      resource: `${base}${resourcePath}`,
      authorization_servers: [base],
      scopes_supported: ['mcp:tools', 'offline_access'],
      bearer_methods_supported: ['header'],
      resource_name: 'DSH Browser Bridge',
      resource_documentation: `${base}${resourcePath}`,
    };
  }

  createOAuthPairingCode(): OAuthPairingCode {
    const code = randomBytes(6).toString('base64url').replace(/[-_]/g, '0').slice(0, 8).toUpperCase();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    this.oauthPairingCodes.set(code, expiresAt);
    return { code, expiresAt };
  }

  private prunePendingAuthorizeRequests(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingAuthorizeRequests) {
      if (entry.expiresAt <= now) this.pendingAuthorizeRequests.delete(id);
    }
  }

  async revokeAllOAuthGrants(): Promise<void> {
    await this.oauthClients.clear();
    this.oauthCodes.clear();
    this.oauthPairingCodes.clear();
    this.pendingAuthorizeRequests.clear();
    await this.oauthRefreshTokens.clearAndPersist();
  }

  private verifyOAuthAccessToken(token: string, issuerOrigin: string): boolean {
    if (!token) return false;
    const audience = `${issuerOrigin}${this.mcpPath}`;
    const claims = verifyAccessToken(this.oauthSigningKey, token, issuerOrigin, audience);
    return claims !== undefined && claims.scope.includes('mcp:tools');
  }

  private setOAuthResourceMetadataFromRequest(req: IncomingMessage): void {
    this.security.setOAuthResourceMetadata(this.oauthResourceMetadataUrl(this.effectiveBaseUrl(req)));
  }

  setPublicOrigin(origin: string | null): void {
    this.publicOrigin = origin;
  }

  effectiveBaseUrl(request: IncomingMessage): string {
    if (this.publicOrigin) {
      return this.publicOrigin;
    }
    const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['cf-forwarded-proto'];
    const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const forwarded = proto ? `${proto}:` : undefined;
    const scheme =
      forwarded === 'https:' || forwarded === 'http:'
        ? forwarded
        : (request.socket as { encrypted?: boolean } | undefined)?.encrypted
          ? 'https:'
          : 'http:';
    const forwardedHostHeader = request.headers['x-forwarded-host'];
    const forwardedHost = Array.isArray(forwardedHostHeader)
      ? forwardedHostHeader[0]
      : forwardedHostHeader;
    const hostHeader = forwardedHost?.split(',')[0]?.trim() || request.headers.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    try {
      return new URL(request.url ?? '/', `${scheme}//${host ?? 'bridge.local'}`).origin;
    } catch {
      return `${scheme}//bridge.local`;
    }
  }

  async start(): Promise<void> {
    if (this.server || this.routeDisposers.length > 0) {
      return;
    }
    if (this.options.carrier) {
      await this.loadPersistedOAuthState();
      const carrierRoutes = [
        { path: this.mcpPath, kind: 'prefix' as const },
        { path: '/.well-known/oauth-protected-resource', kind: 'path' as const },
        { path: '/.well-known/oauth-protected-resource/mcp', kind: 'path' as const },
        { path: this.oauthProtectedResourceIndexPath, kind: 'path' as const },
        { path: this.oauthAuthorizationServerPath, kind: 'path' as const },
       { path: '/.well-known/oauth-authorization-server/mcp', kind: 'path' as const },
        { path: '/.well-known/openid-configuration', kind: 'path' as const },
       { path: this.oauthAuthorizePath, kind: 'path' as const },
        { path: this.oauthTokenPath, kind: 'path' as const },
       { path: this.oauthRegisterPath, kind: 'path' as const },
        { path: this.oauthRevokePath, kind: 'path' as const },
      ];
      for (const route of carrierRoutes) {
        this.routeDisposers.push(this.options.carrier.register({
          ...route,
          handler: (req, res) => this.handleNodeRequest(req, res),
        }));
      }
      const fixedPort = this.options.localConnectorPort
        ?? this.options.config.localConnectorPort
        ?? 0;
      if (
        fixedPort !== 0
        && this.options.config.tunnel.provider === 'cloudflare-named'
        && fixedPort === this.options.carrier.port
      ) {
        for (const dispose of this.routeDisposers.splice(0)) dispose();
        throw new Error(
          'The fixed local connector port conflicts with the DSH WebServer port. Configure a different localConnectorPort for Named Tunnel.',
        );
      }
      this.listeningPort = this.options.carrier.port;
      await this.localConnector.start(fixedPort, {
        fixed: this.options.config.tunnel.provider === 'cloudflare-named' && fixedPort !== 0,
      });
      console.info('[dsh-browser-bridge] local connector started', {
        port: this.localConnector.port,
      });
      return;
    }

    const app = express();
    await this.loadPersistedOAuthState();
    app.disable('x-powered-by');
    app.use(express.json({ limit: this.options.config.limits.requestBodyLimit }));
    app.use(express.urlencoded({ extended: false }));
    const publicRoutes = [
      this.mcpPath,
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      this.oauthProtectedResourceIndexPath,
      '/.well-known/oauth-authorization-server',
     '/.well-known/oauth-authorization-server/mcp',
      '/.well-known/openid-configuration',
     this.oauthAuthorizePath,
      this.oauthTokenPath,
     this.oauthRegisterPath,
      this.oauthRevokePath,
    ];
    for (const route of publicRoutes) {
      app.use(route, (req, res, next) => {
        const fullPath = req.originalUrl
          ? new URL(req.originalUrl, 'http://bridge.local').pathname
          : `${req.baseUrl}${req.path}`;
        if (!this.isOAuthPublicPath(fullPath)) {
          next();
          return;
        }
        this.security.setOAuthResourceMetadata(this.oauthResourceMetadataUrl(this.effectiveBaseUrl(req)));
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
    }
    app.use(this.mcpPath, (req, res, next) => {
      const requestPath = req.originalUrl
        ? new URL(req.originalUrl, 'http://bridge.local').pathname
        : `${req.baseUrl}${req.path}`;
      if (req.method === 'GET' && requestPath === this.healthPath) {
        next();
        return;
      }
      this.setOAuthResourceMetadataFromRequest(req);
      this.security.middleware()(req, res, next);
    });

    app.get(this.oauthResourceMetadataPath, (req, res) => {
      res.json(this.oauthResourceMetadataPayload(req));
    });

    app.get(this.healthPath, (req, res) => {
      const hasAuthorization = Boolean(req.headers.authorization);
      const hasOrigin = Boolean(req.headers.origin);
      const startedAt = Date.now();
      res.once('finish', () => {
        this.security.onAccessLog?.({
          method: 'GET',
          status: res.statusCode,
          reason: 'response',
          durationMs: Date.now() - startedAt,
          hasOrigin,
          originAllowed: false,
          hasAuthorization,
          hasSessionId: false,
        });
      });
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
    await this.localConnector.start(
      this.options.localConnectorPort
      ?? this.options.config.localConnectorPort
      ?? 0,
      {
        fixed: this.options.config.tunnel.provider === 'cloudflare-named'
          && (this.options.localConnectorPort ?? this.options.config.localConnectorPort ?? 0) !== 0,
      },
    );
  }

  allowPublicOrigin(origin: string): void {
    this.publicOrigin = origin;
    this.security.allowPublicOrigin(origin);
  }

  private async loadPersistedOAuthState(): Promise<void> {
    await this.oauthClients.load();
    await this.oauthRefreshTokens.load(
      this.options.oauthSecretStore ?? { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
      OAUTH_REFRESH_TOKENS_SECRET,
    );
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
    // Destroy keep-alive sockets before closing so Windows releases the listener
    // port immediately; otherwise an immediate restart races with TIME_WAIT.
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
    for (const dispose of this.routeDisposers.splice(0)) dispose();
    this.listeningPort = undefined;
  }

  private async handlePost(req: Request, res: Response): Promise<void> {
    try {
      if (this.options.statelessMcp !== false) {
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createBridgeMcpServer(this.options.adapter, this.options.config);
        res.once('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
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
    const accessContext: { bodyMethod?: string; reason?: string | undefined } = {};
    this.setOAuthResourceMetadataFromRequest(req);
    this.logNodeAccess(req, res, accessContext);

    this.security.applyCorsHeaders(req, res);
    const isPreflight = req.method?.toUpperCase() === 'OPTIONS';
    const pathname = new URL(req.url ?? '/', 'http://bridge.local').pathname;
    if (this.isOAuthPublicPath(pathname)) {
      const failure = this.security.authorize(req, { skipBearer: true });
      if (failure) {
        accessContext.reason = failure.reason;
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
    const failure = this.security.authorize(req, { skipBearer: isPreflight || pathname === this.healthPath });
    if (failure) {
      accessContext.reason = failure.reason;
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
    accessContext: { bodyMethod?: string; reason?: string | undefined },
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
        reason: accessContext.reason ?? 'response',
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
    if (this.options.statelessMcp !== false) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = createBridgeMcpServer(this.options.adapter, this.options.config);
      res.once('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
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
      pathname === '/.well-known/oauth-protected-resource' ||
      pathname === '/.well-known/oauth-protected-resource/mcp' ||
      pathname === this.oauthProtectedResourceIndexPath ||
      pathname === this.oauthResourceMetadataPath ||
      pathname === this.oauthAuthorizationServerPath ||
     pathname === '/.well-known/oauth-authorization-server/mcp' ||
      pathname === '/.well-known/openid-configuration' ||
     pathname === this.oauthAuthorizePath ||
      pathname === this.oauthTokenPath ||
     pathname === this.oauthRegisterPath
      || pathname === this.oauthRevokePath
   );
 }

  private oauthAuthorizationServerPayload(request: IncomingMessage): Record<string, unknown> {
    const base = this.effectiveBaseUrl(request);
    return {
      issuer: base,
      authorization_endpoint: `${base}${this.oauthAuthorizePath}`,
      token_endpoint: `${base}${this.oauthTokenPath}`,
     registration_endpoint: `${base}${this.oauthRegisterPath}`,
      revocation_endpoint: `${base}${this.oauthRevokePath}`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:tools', 'offline_access'],
      client_id_metadata_document_supported: true,
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
          html: (body: string) => {
            if (!res.headersSent) {
              res.status(200).type('html').send(body);
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
          html: (body: string) => {
            if (!res.headersSent) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            }
            res.end(body);
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
      html: (body: string) => void;
    },
    pathname: string,
    parsedBody: unknown,
  ): Promise<void> {
    const issuer = this.effectiveBaseUrl(req);
    const resource = `${issuer}${this.mcpPath}`;
    const requestedResource = new URL(req.url ?? '/', issuer).searchParams.get('resource');
    if (requestedResource !== null && requestedResource !== resource) {
      sink().jsonError(400, {
        error: 'invalid_target',
        error_description: 'The OAuth resource does not match this Bridge endpoint',
      });
      return;
    }

    if (
      (
        pathname === this.oauthAuthorizationServerPath
        || pathname === '/.well-known/oauth-authorization-server/mcp'
        || pathname === '/.well-known/openid-configuration'
      )
      && req.method === 'GET'
    ) {
      sink().json(this.oauthAuthorizationServerPayload(req));
      return;
    }
    if (
      (
        pathname === '/.well-known/oauth-protected-resource'
        || pathname === '/.well-known/oauth-protected-resource/mcp'
        || pathname === this.oauthProtectedResourceIndexPath
        || pathname === this.oauthResourceMetadataPath
      ) && req.method === 'GET'
    ) {
      const resourcePath = pathname === '/.well-known/oauth-protected-resource'
        ? '/mcp'
        : pathname === '/.well-known/oauth-protected-resource/mcp'
          ? '/mcp'
          : pathname === this.oauthProtectedResourceIndexPath
            ? this.mcpPath
          : this.mcpPath;
      sink().json(this.oauthResourceMetadataPayload(req, resourcePath));
      return;
    }
    if (pathname === this.oauthRegisterPath && req.method === 'POST') {
      const body = parsedBody ?? (await this.readJsonBody(req));
      const redirectUris = parseRedirectUris(body);
      if (redirectUris.length === 0 || redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
        sink().jsonError(400, {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uris must be https URLs (or http://localhost for development)',
        });
        return;
      }
      const clientId = randomBytes(16).toString('hex');
      const clientName = parseClientName(body);
      await this.oauthClients.save({
        clientId,
        redirectUris,
        clientName,
        createdAt: new Date().toISOString(),
      });
      sink().json({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        ...(clientName ? { client_name: clientName } : {}),
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
      return;
    }
    if (pathname === this.oauthAuthorizePath && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://bridge.local');
      const clientId = url.searchParams.get('client_id') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const codeChallenge = url.searchParams.get('code_challenge') ?? '';
      const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? '';
      const scopes = parseOAuthScopes(url.searchParams.get('scope'));
      const client = this.oauthClients.get(clientId);
      if (!client || !client.redirectUris.includes(redirectUri)) {
        sink().jsonError(400, { error: 'invalid_client', error_description: 'Unknown client or redirect_uri' });
        return;
      }
      if (url.searchParams.get('response_type') !== 'code') {
        sink().jsonError(400, { error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' });
        return;
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        sink().jsonError(400, { error: 'invalid_request', error_description: 'PKCE with S256 is required' });
        return;
      }
      const storedClientName = this.oauthClients.get(clientId)?.clientName;
      const requestId = randomBytes(16).toString('hex');
      this.prunePendingAuthorizeRequests();
      this.pendingAuthorizeRequests.set(requestId, {
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        scopes,
        resource,
        issuer,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      sink().html(this.consentPage(storedClientName ?? clientId, requestId));
      return;
    }
    if (pathname === this.oauthAuthorizePath && req.method === 'POST') {
      this.prunePendingAuthorizeRequests();
      const params = await this.parseOAuthBody(req, parsedBody);
      const requestId = params.get('request_id') ?? '';
      const pairingCode = params.get('pairing_code') ?? '';
      const request = this.pendingAuthorizeRequests.get(requestId);
      if (!request) {
        sink().jsonError(400, {
          error: 'invalid_request',
          error_description: 'Authorization request expired. Restart the connector setup.',
        });
        return;
      }
      const pairingExpiresAt = this.oauthPairingCodes.get(pairingCode);
      if (pairingExpiresAt === undefined || pairingExpiresAt < Date.now()) {
        sink().jsonError(400, {
          error: 'invalid_grant',
          error_description: 'Invalid or expired pairing code',
        });
        return;
      }
      this.pendingAuthorizeRequests.delete(requestId);
      this.oauthPairingCodes.delete(pairingCode);
      const code = randomBytes(24).toString('base64url');
      this.oauthCodes.set(code, {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallengeMethod: request.codeChallengeMethod,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        issuer: request.issuer,
        scopes: request.scopes,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      const target = new URL(request.redirectUri);
      target.searchParams.set('code', code);
      if (request.state) {
        target.searchParams.set('state', request.state);
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
      if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
        sink().jsonError(400, { error: 'unsupported_grant_type' });
        return;
      }
      if (grantType === 'refresh_token') {
        const refreshToken = params.get('refresh_token') ?? '';
        const refresh = await this.oauthRefreshTokens.consumeAndPersist(refreshToken);
        if (
          !refresh
          || refresh.clientId !== clientId
          || refresh.resource !== resource
        ) {
          sink().jsonError(400, {
            error: 'invalid_grant',
            error_description: 'Invalid, expired, or reused refresh token',
          });
          return;
        }
        sink().json(await this.issueOAuthTokens(issuer, resource, refresh.clientId, refresh.scopes));
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
      if (!verifyCodeChallenge(entry.codeChallengeMethod, codeVerifier, entry.codeChallenge)) {
        sink().jsonError(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      sink().json(await this.issueOAuthTokens(entry.issuer, entry.resource, entry.clientId, entry.scopes));
      return;
    }
    if (pathname === this.oauthRevokePath && req.method === 'POST') {
      const params = await this.parseOAuthBody(req, parsedBody);
      const token = params.get('token') ?? '';
      if (token) await this.oauthRefreshTokens.revokeAndPersist(token);
      sink().json({});
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

  private async parseOAuthBody(
    req: IncomingMessage,
    parsedBody: unknown,
  ): Promise<Map<string, string>> {
    if (parsedBody !== undefined) {
      const result = new Map<string, string>();
      if (parsedBody && typeof parsedBody === 'object') {
        for (const [key, value] of Object.entries(parsedBody as Record<string, unknown>)) {
          result.set(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
      }
      return result;
    }
    return this.parseOAuthForm(req);
  }

  private async issueOAuthTokens(
    issuer: string,
    resource: string,
    clientId: string,
    scopes: string[],
  ): Promise<Record<string, unknown>> {
    const accessToken = createAccessToken({
      signingKey: this.oauthSigningKey,
      issuer,
      audience: resource,
      subject: clientId,
      scopes,
    });
    const refreshToken = await this.oauthRefreshTokens.createAndPersist({
      clientId,
      resource,
      scopes,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  private consentPage(clientName: string, requestId: string): string {
    const safeRequestId = escapeHtml(requestId);
    return `<!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>DSH Browser Bridge authorization</title>
      <style>
        :root { color-scheme: light dark; }
        body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f7; color: #1d1d1f; }
        form { box-sizing: border-box; width: 100%; max-width: 420px; padding: 24px; border: 1px solid #d2d2d7; border-radius: 8px; background: #fff; }
        h1 { margin: 0 0 4px; font-size: 20px; }
        p { margin: 0 0 20px; font-size: 14px; color: #56565c; }
        input[type="hidden"] { display: none; }
        input[type="text"] { box-sizing: border-box; width: 100%; padding: 12px; font-size: 22px; letter-spacing: 3px; text-align: center; text-transform: uppercase; border: 1px solid #d2d2d7; border-radius: 6px; }
        button { width: 100%; margin-top: 16px; padding: 12px; font-size: 15px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
      </style>
    </head>
    <body>
      <form method="POST" action="/oauth/authorize">
        <h1>DSH Browser Bridge</h1>
        <p>Authorization request from <strong>${escapeHtml(clientName)}</strong>. Enter the pairing code generated by Bridge.</p>
        <input type="hidden" name="request_id" value="${safeRequestId}">
        <input type="text" name="pairing_code" autocomplete="one-time-code" maxlength="9" autofocus required>
        <button type="submit">Connect</button>
      </form>
    </body>
    </html>`;
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

function parseClientName(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>).client_name;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

function parseOAuthScopes(scope: string | null): string[] {
  const allowed = new Set(['mcp:tools', 'offline_access']);
  const requested = [...new Set((scope ?? '').split(/\s+/).filter(Boolean))]
    .filter((value) => allowed.has(value));
  return requested.length > 0 ? requested : [...allowed];
}

function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function verifyCodeChallenge(method: string, verifier: string, expected: string): boolean {
  if (method !== 'S256' || !verifier) {
    return false;
  }
  const digest = createHash('sha256').update(verifier).digest('base64url');
  return constantTimeEqual(digest, expected);
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

